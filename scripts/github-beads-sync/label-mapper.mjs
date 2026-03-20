/**
 * Maps GitHub issue labels to Beads type and priority.
 *
 * @param {Array<string|{name: string}>} labels - GitHub labels (strings or objects)
 * @param {object} config - Mapping configuration
 * @param {Record<string, string>} config.labelToType - Label name to Beads type
 * @param {Record<string, number>} config.labelToPriority - Label name to priority number
 * @param {string} [config.defaultType="task"] - Fallback type
 * @param {number} [config.defaultPriority=2] - Fallback priority
 * @returns {{ type: string, priority: number }}
 */
export function mapLabels(labels, config) {
  const {
    labelToType = {},
    labelToPriority = {},
    defaultType = 'task',
    defaultPriority = 2,
  } = config;

  // Normalize labels to lowercase strings
  const names = labels.map((l) =>
    (typeof l === 'string' ? l : l.name).toLowerCase()
  );

  // Build lowercase lookup maps
  const typeLookup = Object.create(null);
  for (const [key, value] of Object.entries(labelToType)) {
    typeLookup[key.toLowerCase()] = value;
  }

  const priorityLookup = Object.create(null);
  for (const [key, value] of Object.entries(labelToPriority)) {
    priorityLookup[key.toLowerCase()] = value;
  }

  // First match wins
  let type = defaultType;
  for (const name of names) {
    if (name in typeLookup) {
      type = typeLookup[name];
      break;
    }
  }

  let priority = defaultPriority;
  for (const name of names) {
    if (name in priorityLookup) {
      priority = priorityLookup[name];
      break;
    }
  }

  return { type, priority };
}
