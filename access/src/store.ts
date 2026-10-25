import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { blankIndex, type AccessIndex } from './contracts.js';

export class AccessStore {
  private readonly path: string;
  constructor(root: string) { this.path = join(root, 'access-index.json'); }
  async initialize() { await mkdir(join(this.path, '..'), { recursive: true }); try { await readFile(this.path); } catch { await this.save(blankIndex()); } }
  /**
   * Older files held Access's own node records, from before SEMA Core kept the tree. They are dropped: Core holds the
   * nodes, and Access keeps only their names (nodeDescriptions). The drop is written the next time the file is saved.
   */
  async load(): Promise<AccessIndex> { const index = JSON.parse(await readFile(this.path, 'utf8')) as AccessIndex & { nodes?: unknown }; delete index.nodes; index.nodeDescriptions ??= []; index.testingNotes ??= []; index.changePackets ??= []; index.roleDefinitions ??= []; index.groups ??= []; index.groupMemberships ??= []; index.delegations ??= []; index.capabilityChoices ??= []; index.serviceApprovals ??= []; index.itemNotes ??= []; return index; }
  async save(index: AccessIndex) { const temporary = `${this.path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(index, null, 2)); await rename(temporary, this.path); }
  async update<T>(fn: (index: AccessIndex) => T | Promise<T>) { const index = await this.load(); const result = await fn(index); await this.save(index); return result; }
}
