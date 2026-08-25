// src/parsers/genericXml.js
// Tier 1 config-driven parser for flat scalar XML metadata types.
// To add a type: add a CONFIGS entry + a SUFFIX_MAP entry. No other changes needed.

const { XMLParser } = require('fast-xml-parser');
const { ENTITY_LIMIT_OPTS } = require('../xmlParserLimits');

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: true, ...ENTITY_LIMIT_OPTS });

const CONFIGS = {

  'CustomLabel': {
    typeName: 'Custom Label',
    rootTag: 'CustomLabel',
    scalarKeys: ['value', 'categories', 'language', 'protected', 'shortDescription'],
    listKeys: [],
    picklistKeys: [],
  },

  'UserRole': {
    typeName: 'Role',
    rootTag: 'UserRole',
    scalarKeys: [
      'caseAccessLevel', 'contactAccessLevel', 'description',
      'mayForecastManagerShare', 'name', 'opportunityAccessLevel',
      'parentRole', 'portalType', 'portalAccountAccessLevel',
      'portalContactAccessLevel', 'portalOpportunityAccessLevel',
    ],
    listKeys: [],
    picklistKeys: [],
  },

  'Queue': {
    typeName: 'Queue',
    rootTag: 'Queue',
    scalarKeys: ['name', 'fullName', 'email', 'doesSendEmailToMembers', 'sendEmailToMembers'],
    listKeys: [],
    picklistKeys: [],
  },

  'Group': {
    typeName: 'Public Group',
    rootTag: 'Group',
    scalarKeys: ['name', 'fullName', 'doesIncludeBosses'],
    listKeys: [],
    picklistKeys: [],
  },

  'CustomTab': {
    typeName: 'Custom Tab',
    rootTag: 'CustomTab',
    scalarKeys: [
      'label', 'motif', 'scontrol', 'auraComponent', 'lwcComponent',
      'frameHeight', 'hasSidebar', 'customObject', 'page', 'url',
      'urlEncodingKey', 'description',
    ],
    listKeys: [],
    picklistKeys: [],
  },

  // Column/section detail lives in nested <sections><columns> elements, which
  // Tier 1 does not model -- see the known-limitations note in README.md.
  // Scalars alone still distinguish a NEW report type from a genuine no-change,
  // which is the failure this was added to fix.
  'ReportType': {
    typeName: 'Report Type',
    rootTag: 'ReportType',
    scalarKeys: [
      'label', 'description', 'category', 'baseObject',
      'deployed', 'join',
    ],
    listKeys: [],
    picklistKeys: [],
  },

  'RecordType': {
    typeName: 'Record Type',
    rootTag: 'RecordType',
    scalarKeys: [
      'active', 'businessProcess', 'compactLayoutAssignment',
      'description', 'label', 'master',
    ],
    listKeys: [],
    picklistKeys: [],
  },

  'BusinessProcess': {
    typeName: 'Business Process',
    rootTag: 'BusinessProcess',
    scalarKeys: ['active', 'description', 'namespacePrefix'],
    listKeys: ['values'],
    picklistKeys: [],
  },

  'SharingReason': {
    typeName: 'Sharing Reason',
    rootTag: 'SharingReason',
    scalarKeys: ['label'],
    listKeys: [],
    picklistKeys: [],
  },

  'CompactLayout': {
    typeName: 'Compact Layout',
    rootTag: 'CompactLayout',
    scalarKeys: ['label'],
    listKeys: ['fields'],  // diffed as set; order not tracked
    picklistKeys: [],
  },

  'CustomApplication': {
    typeName: 'Custom Application',
    rootTag: 'CustomApplication',
    scalarKeys: [
      'label', 'description', 'formFactors', 'isNavAutoTempTabsDisabled',
      'isNavPersonalizationDisabled', 'isNavTabPersistenceDisabled',
      'uiType', 'setupExperience', 'systemDefined',
    ],
    listKeys: [],
    picklistKeys: [],
  },

  'GlobalValueSet': {
    typeName: 'Global Value Set',
    rootTag: 'GlobalValueSet',
    scalarKeys: ['description', 'masterLabel', 'sorted'],
    listKeys: [],
    picklistKeys: ['customValue'],  // same active/default diff logic as field.js
  },

  'StandardValueSet': {
    typeName: 'Standard Value Set',
    rootTag: 'StandardValueSet',
    scalarKeys: ['sorted'],
    listKeys: [],
    picklistKeys: ['standardValue'],
  },

  'QuickAction': {
    typeName: 'Quick Action',
    rootTag: 'QuickAction',
    scalarKeys: [
      'label', 'description', 'targetObject', 'targetRecordType',
      'type', 'optionsCreateFeedItem', 'optionsOverrideDefaultCreatedSource',
    ],
    listKeys: [],
    picklistKeys: [],
  },

  'CustomPermission': {
    typeName: 'Custom Permission',
    rootTag: 'CustomPermission',
    scalarKeys: ['label', 'description', 'isLicensed'],
    listKeys: [],
    picklistKeys: [],
  },

  'ExternalDataSource': {
    typeName: 'External Data Source',
    rootTag: 'ExternalDataSource',
    scalarKeys: [
      'label', 'description', 'endpoint', 'isWritable',
      'type', 'principalType', 'protocol', 'certificate',
    ],
    listKeys: [],
    picklistKeys: [],
  },

  'MilestoneType': {
    typeName: 'Milestone Type',
    rootTag: 'MilestoneType',
    scalarKeys: ['description', 'name', 'recurrenceType'],
    listKeys: [],
    picklistKeys: [],
  },

};

// Suffix = everything after the first dot in the filename.
// e.g. "MyLabel.label-meta.xml" → "label-meta.xml"
const SUFFIX_MAP = {
  'label-meta.xml':              'CustomLabel',
  'role-meta.xml':               'UserRole',
  'queue-meta.xml':              'Queue',
  'group-meta.xml':              'Group',
  'tab-meta.xml':                'CustomTab',
  'recordType-meta.xml':         'RecordType',
  'reportType-meta.xml':         'ReportType',
  'businessProcess-meta.xml':    'BusinessProcess',
  'sharingReason-meta.xml':      'SharingReason',
  'compactLayout-meta.xml':      'CompactLayout',
  'app-meta.xml':                'CustomApplication',
  'globalValueSet-meta.xml':     'GlobalValueSet',
  'standardValueSet-meta.xml':   'StandardValueSet',
  'quickAction-meta.xml':        'QuickAction',
  'customPermission-meta.xml':   'CustomPermission',
  'externalDataSource-meta.xml': 'ExternalDataSource',
  'milestoneType-meta.xml':      'MilestoneType',
};

function parseWithConfig(xml, config) {
  const raw = xmlParser.parse(xml)?.[config.rootTag] ?? {};
  const result = {};

  for (const key of config.scalarKeys) {
    if (raw[key] !== undefined && raw[key] !== '') {
      result[key] = String(raw[key]);
    }
  }

  // __list__ prefix: coerced sorted arrays for set-based diffing
  for (const key of config.listKeys) {
    const val = raw[key];
    if (val !== undefined) {
      const arr = Array.isArray(val) ? val : [val];
      result[`__list__${key}`] = arr.map(String).sort();
    }
  }

  // __picklist__ prefix: {fullName, label, isDefault, isActive} per value
  for (const key of config.picklistKeys) {
    const val = raw[key];
    if (val !== undefined) {
      const arr = Array.isArray(val) ? val : [val];
      result[`__picklist__${key}`] = arr.map(v => ({
        fullName:  String(v.fullName ?? v.label ?? ''),
        label:     String(v.label ?? v.fullName ?? ''),
        isDefault: v.default === true || v.default === 'true',
        isActive:  !(v.isActive === false || v.isActive === 'false'),
      }));
    }
  }

  return result;
}

function diffWithConfig(oldXml, newXml, config) {
  const oldR = oldXml ? parseWithConfig(oldXml, config) : {};
  const newR = parseWithConfig(newXml, config);
  const changes = [];

  for (const key of config.scalarKeys) {
    const o = oldR[key], n = newR[key];
    if (o === undefined && n !== undefined) {
      changes.push({ type: 'ADDED', element: key, newValue: n });
    } else if (o !== undefined && n === undefined) {
      changes.push({ type: 'REMOVED', element: key, oldValue: o });
    } else if (o !== undefined && n !== undefined && o !== n) {
      changes.push({ type: 'MODIFIED', element: key, oldValue: o, newValue: n });
    }
  }

  // Order-insensitive set comparison
  for (const key of config.listKeys) {
    const oldSet = new Set(oldR[`__list__${key}`] ?? []);
    const newSet = new Set(newR[`__list__${key}`] ?? []);
    for (const item of newSet) {
      if (!oldSet.has(item)) changes.push({ type: 'ADDED', element: `${key}_item`, newValue: item });
    }
    for (const item of oldSet) {
      if (!newSet.has(item)) changes.push({ type: 'REMOVED', element: `${key}_item`, oldValue: item });
    }
  }

  for (const key of config.picklistKeys) {
    const oldPL = oldR[`__picklist__${key}`] ?? [];
    const newPL = newR[`__picklist__${key}`] ?? [];
    const oldMap = Object.fromEntries(oldPL.map(v => [v.fullName, v]));
    const newMap = Object.fromEntries(newPL.map(v => [v.fullName, v]));

    for (const [name, v] of Object.entries(newMap)) {
      if (!oldMap[name]) {
        changes.push({ type: 'ADDED', element: `${key}:"${name}"`, newValue: formatPicklistValue(v) });
      } else {
        const o = oldMap[name];
        if (o.isDefault !== v.isDefault || o.isActive !== v.isActive) {
          changes.push({ type: 'MODIFIED', element: `${key}:"${name}"`,
            oldValue: formatPicklistValue(o), newValue: formatPicklistValue(v) });
        }
      }
    }
    for (const name of Object.keys(oldMap)) {
      if (!newMap[name]) {
        changes.push({ type: 'REMOVED', element: `${key}:"${name}"`, oldValue: formatPicklistValue(oldMap[name]) });
      }
    }
  }

  return changes;
}

function formatPicklistValue(v) {
  const parts = [v.isDefault ? 'default' : 'not default'];
  if (!v.isActive) parts.push('inactive');
  return parts.join(', ');
}

function createParser(configKey) {
  const config = CONFIGS[configKey];
  if (!config) throw new Error(`[genericXml] Unknown config key: "${configKey}"`);
  return {
    parse: (xml) => parseWithConfig(xml, config),
    diff:  (oldXml, newXml) => diffWithConfig(oldXml, newXml, config),
    componentType: config.typeName,
  };
}

function getParserForSuffix(suffix) {
  const configKey = SUFFIX_MAP[suffix];
  if (!configKey) return null;
  return createParser(configKey);
}

module.exports = { createParser, getParserForSuffix, CONFIGS, SUFFIX_MAP };