import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const provider = new AjvJsonSchemaValidator();
const schemas = {
  UserPromptSubmit: 'user-prompt-submit',
  Stop: 'stop',
  PostToolUse: 'post-tool-use',
} as const;
const validators = Object.fromEntries(await Promise.all(Object.entries(schemas).map(async ([event, name]) => [event,
  provider.getValidator(JSON.parse(await readFile(`test/fixtures/codex-0.162.0/${name}.command.output.schema.json`, 'utf8'))),
])));

export function assertNativeHookOutput(event: keyof typeof schemas, output: unknown): void {
  const result = validators[event](output);
  assert.equal(result.valid, true, result.errorMessage);
}
