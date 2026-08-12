// src/parsers/flexiPage.js
// Semantic parser for Lightning Pages (.flexipage-meta.xml / .flexipage).
// Follows the same parse()/diff() contract as field.js, validationRule.js and flow.js.
//
// Why this parser is not just a genericXml config:
// A FlexiPage stores its layout as a FLAT list of <flexiPageRegions>, wired together
// by GUID facet names ("Facet-9bf5746b-13b3-...") and auto-numbered identifiers
// ("flexipage_column22", "RecordFoo_cField3"). Both churn whenever anything is added,
// so diffing on them yields noise, not meaning. Instead we resolve the facet graph
// into a human-readable containment path and key each placement on
// <what> @ <path>, which is what a reviewer actually cares about:
// "which fields/components are on the page, where, and under what visibility rule".

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

const TOP_LEVEL_SCALARS = ['masterLabel', 'type', 'sobjectType', 'parentFlexiPage', 'description'];

// Pure layout scaffolding: tracked for path resolution but never reported as a
// change on its own. A column only matters through what it contains.
const STRUCTURAL_COMPONENTS = new Set(['flexipage:column']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toArray(val) {
  if (val === undefined || val === null || val === '') return [];
  return Array.isArray(val) ? val : [val];
}

// <...Properties><name>x</name><value>y</value></...Properties> → { x: 'y' }
function propsToMap(rawProps) {
  const map = {};
  for (const p of toArray(rawProps)) {
    if (p?.name === undefined) continue;
    map[String(p.name)] = p.value === undefined ? '' : String(p.value);
  }
  return map;
}

// Renders a visibilityRule as a stable one-liner.
// "1 AND 2 [{!Record.Vertical__c} EQUAL \"Non-Hospital\"; {!Record.N__c} GT \"0\"]"
function describeVisibility(vr) {
  if (!vr) return 'always';
  const criteria = toArray(vr.criteria).map((c) => {
    const left  = String(c?.leftValue ?? '');
    const op    = String(c?.operator ?? '');
    const right = c?.rightValue === undefined ? '' : String(c.rightValue);
    return `${left} ${op} ${JSON.stringify(right)}`;
  });
  if (!criteria.length) return 'always';
  const filter = vr.booleanFilter !== undefined && vr.booleanFilter !== ''
    ? String(vr.booleanFilter)
    : criteria.map((_, i) => i + 1).join(' AND ');
  return `${filter} [${criteria.join('; ')}]`;
}

function shortComponentName(componentName) {
  const s = String(componentName ?? '');
  const colon = s.indexOf(':');
  return colon === -1 ? s : s.slice(colon + 1);
}

// ---------------------------------------------------------------------------
// Region graph
//
// Regions are flat and reference each other by name through component
// properties (fieldSection.columns → Facet-x, column.body → Facet-y).
// We do not hardcode which property names are facet pointers: ANY property
// whose value matches a region name is treated as one. That keeps the parser
// correct for component types we have not seen.
// ---------------------------------------------------------------------------
function buildRegionGraph(regions) {
  const byName = new Map();
  for (const r of regions) {
    const name = String(r?.name ?? '');
    if (name) byName.set(name, r);
  }

  // childRegionName → { parentRegionName, segment }
  const parentOf = new Map();

  for (const region of regions) {
    const regionName = String(region?.name ?? '');
    for (const item of toArray(region?.itemInstances)) {
      const ci = item?.componentInstance;
      if (!ci) continue;
      const props = propsToMap(ci.componentInstanceProperties);
      const componentName = String(ci.componentName ?? '');
      for (const value of Object.values(props)) {
        if (!byName.has(value) || value === regionName) continue;
        // A facet pointed at by a column contributes no readable path segment;
        // anything else contributes its label (falling back to its type).
        const segment = STRUCTURAL_COMPONENTS.has(componentName)
          ? null
          : (props.label || props.title || shortComponentName(componentName));
        parentOf.set(value, { parentRegionName: regionName, segment });
      }
    }
  }

  return { byName, parentOf };
}

// Walks a region up to its root, producing "main > Details > Distinct Weeks".
function regionPath(regionName, parentOf) {
  const segments = [];
  const seen = new Set();
  let current = regionName;

  while (current && !seen.has(current)) {
    seen.add(current);
    const edge = parentOf.get(current);
    if (!edge) {
      // Root region: its own name is meaningful ("main", "sidebar", "header").
      segments.unshift(current);
      break;
    }
    if (edge.segment) segments.unshift(edge.segment);
    current = edge.parentRegionName;
  }

  return segments.join(' > ') || regionName;
}

// Assigns a unique key, disambiguating repeats of the same thing in one path.
function addUnique(map, baseKey, value) {
  let key = baseKey;
  let n = 2;
  while (map[key] !== undefined) key = `${baseKey} #${n++}`;
  map[key] = value;
}

// ---------------------------------------------------------------------------
// parse(xml)
// ---------------------------------------------------------------------------
function parse(xml) {
  const raw = parser.parse(xml)?.FlexiPage ?? {};
  const result = {};

  for (const key of TOP_LEVEL_SCALARS) {
    if (raw[key] !== undefined && raw[key] !== '') result[key] = String(raw[key]);
  }
  if (raw.template?.name !== undefined) result.template = String(raw.template.name);

  const regions = toArray(raw.flexiPageRegions);
  const { parentOf } = buildRegionGraph(regions);

  const fields     = {};
  const components = {};

  for (const region of regions) {
    const regionName = String(region?.name ?? '');
    const path = regionPath(regionName, parentOf);

    for (const item of toArray(region?.itemInstances)) {
      if (item?.fieldInstance) {
        const fi = item.fieldInstance;
        const fieldItem = String(fi.fieldItem ?? 'unknown');
        const props = propsToMap(fi.fieldInstanceProperties);
        addUnique(fields, `${fieldItem} @ ${path}`, {
          uiBehavior: props.uiBehavior ?? 'none',
          visibility: describeVisibility(fi.visibilityRule),
        });
      }

      if (item?.componentInstance) {
        const ci = item.componentInstance;
        const componentName = String(ci.componentName ?? 'unknown');
        if (STRUCTURAL_COMPONENTS.has(componentName)) continue;

        const props = propsToMap(ci.componentInstanceProperties);
        // Drop facet-pointer props: their values are GUIDs that change on any edit.
        // The referenced facet's own contents are diffed separately.
        const meaningfulProps = {};
        for (const [k, v] of Object.entries(props)) {
          if (parentOf.has(v)) continue;
          meaningfulProps[k] = v;
        }

        const label = props.label || props.title || '';
        const baseKey = label
          ? `${componentName} "${label}" @ ${path}`
          : `${componentName} @ ${path}`;

        addUnique(components, baseKey, {
          ...meaningfulProps,
          visibility: describeVisibility(ci.visibilityRule),
        });
      }
    }
  }

  // Non-"__" summary keys. diff() ignores these (it diffs an explicit key list),
  // but the NEW/DELETED paths in cli.js and mcp-server.js render every non-"__"
  // key -- without them a brand-new page would report scalars and nothing else.
  result.field_count     = String(Object.keys(fields).length);
  result.component_count = String(Object.keys(components).length);
  const sectionLabels = Object.values(components)
    .map((c) => c.label)
    .filter(Boolean);
  if (sectionLabels.length) result.sections = [...new Set(sectionLabels)].join(', ');

  result.__fields     = fields;
  result.__components = components;
  return result;
}

// ---------------------------------------------------------------------------
// describeEntry — pipe-delimited rendering, matching flow.js
// ---------------------------------------------------------------------------
function describeEntry(extracted) {
  return Object.entries(extracted)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join(' | ');
}

function diffMaps(oldMap, newMap, label, changes) {
  for (const [name, newEl] of Object.entries(newMap)) {
    if (!oldMap[name]) {
      changes.push({ type: 'ADDED', element: `${label}:${name}`, newValue: describeEntry(newEl) });
    } else if (JSON.stringify(oldMap[name]) !== JSON.stringify(newEl)) {
      changes.push({
        type: 'MODIFIED',
        element: `${label}:${name}`,
        oldValue: describeEntry(oldMap[name]),
        newValue: describeEntry(newEl),
      });
    }
  }
  for (const [name, oldEl] of Object.entries(oldMap)) {
    if (!newMap[name]) {
      changes.push({ type: 'REMOVED', element: `${label}:${name}`, oldValue: describeEntry(oldEl) });
    }
  }
}

// ---------------------------------------------------------------------------
// diff(oldXml, newXml) — returns SemanticChange[]
// ---------------------------------------------------------------------------
function diff(oldXml, newXml) {
  const oldP = oldXml ? parse(oldXml) : {};
  const newP = parse(newXml);
  const changes = [];

  for (const key of [...TOP_LEVEL_SCALARS, 'template']) {
    const o = oldP[key], n = newP[key];
    if (o === undefined && n !== undefined) {
      changes.push({ type: 'ADDED', element: key, newValue: n });
    } else if (o !== undefined && n === undefined) {
      changes.push({ type: 'REMOVED', element: key, oldValue: o });
    } else if (o !== undefined && n !== undefined && o !== n) {
      changes.push({ type: 'MODIFIED', element: key, oldValue: o, newValue: n });
    }
  }

  diffMaps(oldP.__fields ?? {},     newP.__fields ?? {},     'field',     changes);
  diffMaps(oldP.__components ?? {}, newP.__components ?? {}, 'component', changes);

  return changes;
}

module.exports = { parse, diff };
