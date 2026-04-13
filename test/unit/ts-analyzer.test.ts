/**
 * Unit Tests: TypeScript Analyzer — barrel resolution & USES_TYPE edges
 *
 * These tests exercise the TS analyzer's barrel file (index.ts re-export)
 * resolution and generic type argument tracking (USES_TYPE edges) by
 * creating minimal temp file fixtures and running analyzeTypeScript.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeTypeScript } from '../../src/analyzers/ts-analyzer.js';
import { RelationshipType } from '../../src/graph/types.js';

// ─── Shared temp directory ──────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `recon-ts-test-${Date.now()}`);
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort
  }
});

// ─── Barrel File Resolution ─────────────────────────────────────

describe('barrel file resolution', () => {
  let projectRoot: string;

  beforeAll(() => {
    // Layout:
    //   project/src/models/foo.ts      — exports Foo
    //   project/src/models/index.ts    — re-exports Foo from ./foo
    //   project/src/consumer/bar.ts    — imports { Foo } from "../models"
    projectRoot = join(tmpRoot, 'barrel-project');
    const srcRoot = join(projectRoot, 'src');
    const modelsDir = join(srcRoot, 'models');
    const consumerDir = join(srcRoot, 'consumer');

    mkdirSync(modelsDir, { recursive: true });
    mkdirSync(consumerDir, { recursive: true });

    writeFileSync(
      join(modelsDir, 'foo.ts'),
      'export interface Foo { id: string; }\n',
    );

    writeFileSync(
      join(modelsDir, 'index.ts'),
      'export { Foo } from "./foo";\n',
    );

    writeFileSync(
      join(consumerDir, 'bar.ts'),
      [
        'import { Foo } from "../models";',
        '',
        'export function useFoo(): Foo {',
        '  return { id: "1" };',
        '}',
      ].join('\n') + '\n',
    );
  });

  it('creates IMPORTS edge from consumer to barrel AND to original source', async () => {
    // webAppRelPath = "." so srcRoot = projectRoot/src
    const { result } = await analyzeTypeScript(projectRoot, '.');

    // Filter IMPORTS edges originating from bar.ts
    const barFileId = 'ts:file:src/consumer/bar.ts';
    const importEdges = result.relationships.filter(
      (r) => r.type === RelationshipType.IMPORTS && r.sourceId === barFileId,
    );

    // Should have an edge to the barrel (index.ts)
    const toBarrel = importEdges.find(
      (r) => r.targetId === 'ts:file:src/models/index.ts',
    );
    expect(toBarrel).toBeDefined();

    // Should also have a barrel-resolved edge to the original source (foo.ts)
    const toOriginal = importEdges.find(
      (r) => r.targetId === 'ts:file:src/models/foo.ts',
    );
    expect(toOriginal).toBeDefined();
    // Barrel-resolved edges have slightly lower confidence
    expect(toOriginal!.confidence).toBe(0.9);
  });

  it('barrel itself imports the original source', async () => {
    const { result } = await analyzeTypeScript(projectRoot, '.');

    const barrelFileId = 'ts:file:src/models/index.ts';
    const barrelImports = result.relationships.filter(
      (r) => r.type === RelationshipType.IMPORTS && r.sourceId === barrelFileId,
    );

    const toFoo = barrelImports.find(
      (r) => r.targetId === 'ts:file:src/models/foo.ts',
    );
    expect(toFoo).toBeDefined();
  });
});

// ─── USES_TYPE Relationship ─────────────────────────────────────

describe('USES_TYPE edges from generic type arguments', () => {
  let projectRoot: string;

  beforeAll(() => {
    // Layout:
    //   project/src/types/user.ts      — exports type User
    //   project/src/services/query.ts  — imports User, uses Promise<User>
    projectRoot = join(tmpRoot, 'uses-type-project');
    const srcRoot = join(projectRoot, 'src');
    const typesDir = join(srcRoot, 'types');
    const servicesDir = join(srcRoot, 'services');

    mkdirSync(typesDir, { recursive: true });
    mkdirSync(servicesDir, { recursive: true });

    writeFileSync(
      join(typesDir, 'user.ts'),
      'export interface User { id: string; name: string; }\n',
    );

    writeFileSync(
      join(servicesDir, 'query.ts'),
      [
        'import { User } from "../types/user";',
        '',
        'export async function fetchUser(id: string): Promise<User> {',
        '  return { id, name: "test" };',
        '}',
      ].join('\n') + '\n',
    );
  });

  it('creates USES_TYPE edge from function to imported type used as generic argument', async () => {
    const { result } = await analyzeTypeScript(projectRoot, '.');

    const usesTypeEdges = result.relationships.filter(
      (r) => r.type === RelationshipType.USES_TYPE,
    );

    // fetchUser should have a USES_TYPE edge pointing to User
    const fetchUserToUser = usesTypeEdges.find(
      (r) =>
        r.sourceId === 'ts:func:src/services/query.ts:fetchUser' &&
        r.targetId === 'ts:iface:src/types/user.ts:User',
    );
    expect(fetchUserToUser).toBeDefined();
    expect(fetchUserToUser!.confidence).toBe(0.8);
  });

  it('does not create USES_TYPE for non-imported types', async () => {
    // Add a file that uses a generic with a type NOT imported
    const srcRoot = join(projectRoot, 'src');
    writeFileSync(
      join(srcRoot, 'services', 'local.ts'),
      [
        'interface LocalType { x: number; }',
        '',
        'export function doStuff(): Promise<LocalType> {',
        '  return Promise.resolve({ x: 1 });',
        '}',
      ].join('\n') + '\n',
    );

    const { result } = await analyzeTypeScript(projectRoot, '.');

    // doStuff should NOT have USES_TYPE to LocalType because LocalType is
    // defined locally, not imported (walkTypeArgs only tracks imported types)
    const doStuffEdges = result.relationships.filter(
      (r) =>
        r.type === RelationshipType.USES_TYPE &&
        r.sourceId === 'ts:func:src/services/local.ts:doStuff',
    );
    expect(doStuffEdges).toHaveLength(0);
  });
});
