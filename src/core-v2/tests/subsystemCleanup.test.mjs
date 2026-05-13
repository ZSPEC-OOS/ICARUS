import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const SERVICES = `${ROOT}/src/services`;

// ─── Deleted files ────────────────────────────────────────────────────────────

describe('Deleted subsystem files do not exist', () => {
  const deletedFiles = [
    `${SERVICES}/bluswanSimpleMode.js`,
    `${SERVICES}/selfImproveService.js`,
    `${SERVICES}/interactivePipeline.js`,
    `${SERVICES}/intentAmplifier.js`,
    `${SERVICES}/intentClassifier.js`,
    `${SERVICES}/tddLoop.js`,
    `${SERVICES}/executionSandbox.js`,
    `${SERVICES}/enhancers/critiqueMiddleware.js`,
    `${SERVICES}/enhancers/structuredPrompting.js`,
    `${SERVICES}/orchestration/modelRouter.js`,
    `${SERVICES}/orchestration/taskDecomposer.js`,
    `${SERVICES}/promptRegistry.js`,
    `${SERVICES}/bluswanTestPrompts.js`,
  ];

  for (const filePath of deletedFiles) {
    const name = filePath.replace(`${SERVICES}/`, '');
    it(`${name} does not exist`, () => {
      assert.equal(existsSync(filePath), false, `Expected ${name} to be deleted`);
    });
  }

  it('efficiency/ directory does not exist', () => {
    assert.equal(existsSync(`${SERVICES}/efficiency`), false, 'Expected efficiency/ directory to be deleted');
  });
});

// ─── New telemetry file exists ────────────────────────────────────────────────

describe('New telemetry module exists and exports correctly', () => {
  it('telemetry.js exists', () => {
    const telemetryPath = resolve(import.meta.dirname, '../telemetry.js');
    assert.equal(existsSync(telemetryPath), true, 'telemetry.js should exist');
  });

  it('createTelemetrySink is exported from telemetry.js', async () => {
    const { createTelemetrySink } = await import('../telemetry.js');
    assert.equal(typeof createTelemetrySink, 'function');
  });

  it('createTelemetrySink is re-exported from core-v2/index.js', async () => {
    const mod = await import('../index.js');
    assert.equal(typeof mod.createTelemetrySink, 'function');
  });
});

// ─── V1 fallback files still exist ───────────────────────────────────────────

describe('V1 fallback files are preserved', () => {
  const keepFiles = [
    `${SERVICES}/agentLoop.js`,
    `${SERVICES}/agentExecutor.js`,
    `${SERVICES}/reliability/fsm.js`,
  ];

  for (const filePath of keepFiles) {
    const name = filePath.replace(`${ROOT}/`, '');
    it(`${name} is preserved`, () => {
      assert.equal(existsSync(filePath), true, `Expected ${name} to still exist`);
    });
  }
});

// ─── Non-empty remaining directories ─────────────────────────────────────────

describe('Remaining directories are not empty', () => {
  it('src/services/enhancers/ still has files (not fully removed)', () => {
    assert.equal(existsSync(`${SERVICES}/enhancers`), true);
    // qualityFloor.js and config.js should remain
    assert.equal(existsSync(`${SERVICES}/enhancers/qualityFloor.js`), true);
    assert.equal(existsSync(`${SERVICES}/enhancers/config.js`), true);
  });

  it('src/services/orchestration/ still has files (not fully removed)', () => {
    assert.equal(existsSync(`${SERVICES}/orchestration`), true);
    // taskClassifier.js should remain
    assert.equal(existsSync(`${SERVICES}/orchestration/taskClassifier.js`), true);
  });

  it('src/services/reliability/ is preserved', () => {
    assert.equal(existsSync(`${SERVICES}/reliability/fsm.js`), true);
  });
});
