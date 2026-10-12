import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CATEGORY_LABELS, STATUS_LABELS, PROGRESS_GUIDANCE, validateProgress } from './schema.js';

export async function runMcp(): Promise<void> {
  const server = new Server({ name: 'whativedone', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: PROGRESS_GUIDANCE });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'classify_progress', description: 'Classify current progress for the WhatIveDone journal at meaningful milestones and before stopping. This tool validates category and status; the native PostToolUse hook saves successful classifications. Send no task text.',
    inputSchema: { type: 'object', properties: { category: { type: 'string', enum: [...Object.keys(CATEGORY_LABELS), 'none'] }, status: { type: 'string', enum: [...Object.keys(STATUS_LABELS), 'unknown'] } }, required: ['category', 'status'], additionalProperties: false }
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const progress = request.params.name === 'classify_progress' ? validateProgress(request.params.arguments) : null;
    return progress ? { content: [{ type: 'text', text: JSON.stringify(progress) }] } : { isError: true, content: [{ type: 'text', text: request.params.name === 'classify_progress' ? 'invalid_progress' : 'unknown_tool' }] };
  });
  await server.connect(new StdioServerTransport());
}
