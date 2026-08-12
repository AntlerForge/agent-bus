export function borgScriptCoversLegacySources(script) {
  const sourceAssignment = script.match(/sources\s*=\s*\(([^)]*)\)/s)?.[1] || "";
  const declared = new Set(sourceAssignment.match(/\/(?:[^\s'"\\)]+|\\.)+/g) || []);
  return declared.has("/share") && declared.has("/srv");
}
