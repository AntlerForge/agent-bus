import YAML from "yaml";

export function parseMarkdownWithFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) {
    return { data: {}, body: markdown };
  }

  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("Malformed frontmatter: missing closing delimiter");
  }

  const yamlText = markdown.slice(4, end);
  const bodyStart = markdown.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : markdown.slice(bodyStart + 1);
  const data = YAML.parse(yamlText) || {};
  return { data, body };
}

export function stringifyMarkdownWithFrontmatter(data, body) {
  const yamlText = YAML.stringify(data).trimEnd();
  return `---\n${yamlText}\n---\n\n${body.trimEnd()}\n`;
}

export function messageBody(subject, body) {
  const title = subject?.trim() || "Message";
  return `# ${title}\n\n${body.trimEnd()}\n`;
}

export function appendThreadEntry(existingBody, { seq, id, created, from, to, body }) {
  const entry = [
    `## ${seq}. ${created} - ${from} to ${to}`,
    "",
    `Message: \`${id}\``,
    "",
    body.trimEnd(),
    "",
  ].join("\n");
  return `${existingBody.trimEnd()}\n\n${entry}`.trimStart();
}
