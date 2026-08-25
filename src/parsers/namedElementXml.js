// src/parsers/namedElementXml.js
// Tier 2 config-driven parser for XML metadata types with named sub-elements.
// To add a type: add the tag(s) to ALWAYS_ARRAY_TAGS, add a CONFIGS entry + SUFFIX_MAP entry.

const { XMLParser } = require('fast-xml-parser');
const { ENTITY_LIMIT_OPTS } = require('../xmlParserLimits');

// fast-xml-parser returns an object (not array) when only one instance of a
// repeating tag is present. ALWAYS_ARRAY_TAGS forces array for all named
// sub-element tags so diff logic doesn't silently break on single-item files.
// Every tag used as namedElements.tag in any config must appear here.
const ALWAYS_ARRAY_TAGS = new Set([
  'fieldPermissions', 'objectPermissions', 'userPermissions',
  'classAccesses', 'pageAccesses', 'applicationVisibilities',
  'recordTypeVisibilities', 'tabVisibilities', 'customPermissions',
  'flowAccesses', 'customMetadataTypeAccesses', 'externalDataSourceAccesses',
  'rules', 'alerts', 'fieldUpdates', 'outboundMessages', 'tasks',
  'assignmentRule', 'autoResponseRule', 'escalationRule',
  'sharingCriteriaRules', 'sharingOwnerRules', 'sharingGuestRules',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  isArray: (tagName) => ALWAYS_ARRAY_TAGS.has(tagName),
  ...ENTITY_LIMIT_OPTS,
});

const CONFIGS = {

  'Profile': {
    typeName: 'Profile',
    rootTag: 'Profile',
    scalarKeys: ['custom', 'description', 'userLicense'],
    namedElements: [
      { tag: 'fieldPermissions', label: 'field_permission', nameKey: 'field',
        scalarKeys: ['readable', 'editable'], listKeys: [] },
      { tag: 'objectPermissions', label: 'object_permission', nameKey: 'object',
        scalarKeys: ['allowCreate', 'allowDelete', 'allowEdit', 'allowRead', 'modifyAllRecords', 'viewAllRecords'], listKeys: [] },
      { tag: 'userPermissions', label: 'user_permission', nameKey: 'name',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'classAccesses', label: 'class_access', nameKey: 'apexClass',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'pageAccesses', label: 'page_access', nameKey: 'apexPage',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'applicationVisibilities', label: 'app_visibility', nameKey: 'application',
        scalarKeys: ['default', 'visible'], listKeys: [] },
      { tag: 'recordTypeVisibilities', label: 'record_type_visibility', nameKey: 'recordType',
        scalarKeys: ['default', 'personAccountDefault', 'visible'], listKeys: [] },
      { tag: 'tabVisibilities', label: 'tab_visibility', nameKey: 'tab',
        scalarKeys: ['visibility'], listKeys: [] },
      { tag: 'customPermissions', label: 'custom_permission', nameKey: 'name',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'flowAccesses', label: 'flow_access', nameKey: 'flow',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'externalDataSourceAccesses', label: 'external_datasource_access', nameKey: 'externalDataSource',
        scalarKeys: ['enabled'], listKeys: [] },
    ],
  },

  'PermissionSet': {
    typeName: 'Permission Set',
    rootTag: 'PermissionSet',
    scalarKeys: ['description', 'hasActivationRequired', 'label', 'license', 'userLicense'],
    namedElements: [
      { tag: 'fieldPermissions', label: 'field_permission', nameKey: 'field',
        scalarKeys: ['readable', 'editable'], listKeys: [] },
      { tag: 'objectPermissions', label: 'object_permission', nameKey: 'object',
        scalarKeys: ['allowCreate', 'allowDelete', 'allowEdit', 'allowRead', 'modifyAllRecords', 'viewAllRecords'], listKeys: [] },
      { tag: 'userPermissions', label: 'user_permission', nameKey: 'name',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'classAccesses', label: 'class_access', nameKey: 'apexClass',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'pageAccesses', label: 'page_access', nameKey: 'apexPage',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'applicationVisibilities', label: 'app_visibility', nameKey: 'application',
        scalarKeys: ['default', 'visible'], listKeys: [] },
      { tag: 'recordTypeVisibilities', label: 'record_type_visibility', nameKey: 'recordType',
        scalarKeys: ['default', 'personAccountDefault', 'visible'], listKeys: [] },
      { tag: 'tabVisibilities', label: 'tab_visibility', nameKey: 'tab',
        scalarKeys: ['visibility'], listKeys: [] },
      { tag: 'customPermissions', label: 'custom_permission', nameKey: 'name',
        scalarKeys: ['enabled'], listKeys: [] },
      { tag: 'flowAccesses', label: 'flow_access', nameKey: 'flow',
        scalarKeys: ['enabled'], listKeys: [] },
    ],
  },

  // Config key is 'WorkflowMetadata' to avoid a future suffix collision with genericXml.
  'WorkflowMetadata': {
    typeName: 'Workflow',
    rootTag: 'Workflow',
    scalarKeys: [],
    namedElements: [
      { tag: 'rules', label: 'workflow_rule', nameKey: 'fullName',
        scalarKeys: ['active', 'booleanFilter', 'description', 'triggerType'], listKeys: [] },
      { tag: 'alerts', label: 'email_alert', nameKey: 'fullName',
        scalarKeys: ['ccEmails', 'description', 'protected', 'senderAddress', 'senderType', 'template'], listKeys: [] },
      { tag: 'fieldUpdates', label: 'field_update', nameKey: 'fullName',
        scalarKeys: ['description', 'field', 'formula', 'literalValue', 'lookupValue',
          'lookupValueType', 'name', 'notifyAssignee', 'operation', 'protected', 'targetObject'], listKeys: [] },
      { tag: 'outboundMessages', label: 'outbound_message', nameKey: 'fullName',
        scalarKeys: ['apiVersion', 'description', 'endpointUrl', 'includeSessionId',
          'integrationUser', 'name', 'protected'], listKeys: ['fields'] },
      { tag: 'tasks', label: 'workflow_task', nameKey: 'fullName',
        scalarKeys: ['assignedTo', 'assignedToType', 'description', 'dueDateOffset', 'notifyAssignee',
          'offsetFromField', 'priority', 'protected', 'status', 'subject'], listKeys: [] },
    ],
  },

  // Rule criteria are not diffed at this tier — active status is the primary signal.
  'AssignmentRules': {
    typeName: 'Assignment Rules',
    rootTag: 'AssignmentRules',
    scalarKeys: [],
    namedElements: [
      { tag: 'assignmentRule', label: 'assignment_rule', nameKey: 'fullName',
        scalarKeys: ['active'], listKeys: [] },
    ],
  },

  'AutoResponseRules': {
    typeName: 'Auto-Response Rules',
    rootTag: 'AutoResponseRules',
    scalarKeys: [],
    namedElements: [
      { tag: 'autoResponseRule', label: 'auto_response_rule', nameKey: 'fullName',
        scalarKeys: ['active'], listKeys: [] },
    ],
  },

  'EscalationRules': {
    typeName: 'Escalation Rules',
    rootTag: 'EscalationRules',
    scalarKeys: [],
    namedElements: [
      { tag: 'escalationRule', label: 'escalation_rule', nameKey: 'fullName',
        scalarKeys: ['active'], listKeys: [] },
    ],
  },

  'SharingRules': {
    typeName: 'Sharing Rules',
    rootTag: 'SharingRules',
    scalarKeys: [],
    namedElements: [
      { tag: 'sharingCriteriaRules', label: 'criteria_rule', nameKey: 'fullName',
        scalarKeys: ['accessLevel', 'accountAccessLevel', 'caseAccessLevel', 'contactAccessLevel',
          'description', 'label', 'opportunityAccessLevel', 'name'], listKeys: [] },
      { tag: 'sharingOwnerRules', label: 'owner_rule', nameKey: 'fullName',
        scalarKeys: ['accessLevel', 'accountAccessLevel', 'caseAccessLevel', 'contactAccessLevel',
          'description', 'label', 'opportunityAccessLevel', 'name'], listKeys: [] },
      { tag: 'sharingGuestRules', label: 'guest_rule', nameKey: 'fullName',
        scalarKeys: ['accessLevel', 'description', 'label', 'name'], listKeys: [] },
    ],
  },

};

const SUFFIX_MAP = {
  'profile-meta.xml':             'Profile',
  'permissionset-meta.xml':       'PermissionSet',
  'workflow-meta.xml':            'WorkflowMetadata',
  'assignmentRules-meta.xml':     'AssignmentRules',
  'autoResponseRules-meta.xml':   'AutoResponseRules',
  'escalationRules-meta.xml':     'EscalationRules',
  'sharingRules-meta.xml':        'SharingRules',
};

function parseWithConfig(xml, config) {
  const raw = xmlParser.parse(xml)?.[config.rootTag] ?? {};
  const result = {};

  for (const key of config.scalarKeys) {
    if (raw[key] !== undefined && raw[key] !== '') {
      result[key] = String(raw[key]);
    }
  }

  // __namedMap__ prefix: { [nameKey value]: extracted scalars } per element type
  for (const elConfig of config.namedElements) {
    const rawArr = raw[elConfig.tag];
    if (!rawArr) continue;
    const arr = Array.isArray(rawArr) ? rawArr : [rawArr];
    const map = {};
    for (const el of arr) {
      const nameVal = el[elConfig.nameKey];
      if (nameVal === undefined) continue;
      const extracted = {};
      for (const sk of elConfig.scalarKeys) {
        if (el[sk] !== undefined) extracted[sk] = String(el[sk]);
      }
      for (const lk of (elConfig.listKeys ?? [])) {
        if (el[lk] !== undefined) {
          const lArr = Array.isArray(el[lk]) ? el[lk] : [el[lk]];
          extracted[`__list__${lk}`] = lArr.map(String).sort();
        }
      }
      map[String(nameVal)] = extracted;
    }
    result[`__namedMap__${elConfig.tag}`] = map;
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

  for (const elConfig of config.namedElements) {
    const mapKey = `__namedMap__${elConfig.tag}`;
    const oldMap = oldR[mapKey] ?? {};
    const newMap = newR[mapKey] ?? {};

    for (const [name, newEl] of Object.entries(newMap)) {
      if (!oldMap[name]) {
        changes.push({ type: 'ADDED', element: `${elConfig.label}:"${name}"`,
          newValue: describeElement(newEl, elConfig) });
      } else if (JSON.stringify(oldMap[name]) !== JSON.stringify(newEl)) {
        changes.push({ type: 'MODIFIED', element: `${elConfig.label}:"${name}"`,
          oldValue: describeElement(oldMap[name], elConfig),
          newValue: describeElement(newEl, elConfig) });
      }
    }
    for (const name of Object.keys(oldMap)) {
      if (!newMap[name]) {
        changes.push({ type: 'REMOVED', element: `${elConfig.label}:"${name}"`,
          oldValue: describeElement(oldMap[name], elConfig) });
      }
    }
  }

  return changes;
}

// Outputs verbatim key:value pairs, pipe-delimited.
// e.g. 'readable:"true" | editable:"false"'
function describeElement(extracted, elConfig) {
  const parts = [];
  for (const key of elConfig.scalarKeys) {
    if (extracted[key] !== undefined) parts.push(`${key}:${JSON.stringify(extracted[key])}`);
  }
  for (const lk of (elConfig.listKeys ?? [])) {
    const arr = extracted[`__list__${lk}`];
    if (arr?.length) parts.push(`${lk}:[${arr.map(v => JSON.stringify(v)).join(', ')}]`);
  }
  return parts.join(' | ');
}

function createParser(configKey) {
  const config = CONFIGS[configKey];
  if (!config) throw new Error(`[namedElementXml] Unknown config key: "${configKey}"`);
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