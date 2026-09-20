import { describe, expect, it } from 'vitest';
import { automationEnvironment, isAutomationInvocation, parseAutomationCommand } from '../automation-command.js';
import { schemaIdentity, transactionalSql } from '../automation.js';

describe('automation boundary', () => {
  it('routes only opted-in automation commands', () => {
    expect(isAutomationInvocation(['projects'])).toBe(false);
    expect(isAutomationInvocation(['code-findings','add','--json'])).toBe(false);
    expect(isAutomationInvocation(['ingest','--json=false'])).toBe(true);
  });
  it.each([
    ['capabilities','--json=false'], ['capabilities','--json','--json'],
    ['database','drop','--json'], ['projects','ensure','--json','--slug','a'],
    ['ingest','--scan','--json'], ['ingest','--transcript','/x','--harness','claude-code','--json'],
  ])('rejects invalid machine arguments %j', (...argv) => {
    expect(() => parseAutomationCommand(argv)).toThrow();
  });
  it('parses each exact command', () => {
    expect(parseAutomationCommand(['capabilities','--json'])).toEqual({operation:'capabilities'});
    expect(parseAutomationCommand(['database','ensure','--json'])).toEqual({operation:'database_ensure'});
    expect(parseAutomationCommand(['projects','ensure','--slug','a','--root','/x','--json']))
      .toEqual({operation:'project_ensure',slug:'a',root:'/x'});
    expect(parseAutomationCommand(['ingest','--transcript','/x','--harness','codex','--json']))
      .toEqual({operation:'targeted_ingest',transcript:'/x',harness:'codex'});
  });
  it('drops credentials and provider activation', () => {
    const env = automationEnvironment({MAI_DB_URL:'database',MAI_PROJECT_SLUG:'a',
      OPENAI_API_KEY:'private',ANTHROPIC_API_KEY:'private',GH_TOKEN:'private',
      SSH_AUTH_SOCK:'/private',HOME:'/private',MAI_LLM_SUMMARY:'1',MAI_EMBEDDINGS:'1'});
    expect(env).toEqual({MAI_DB_URL:'database',MAI_PROJECT_SLUG:'a',
      MAI_LLM_PROVIDER:'none',MAI_LLM_SUMMARY:'0',MAI_EMBEDDINGS:'0'});
  });
  it('strips only a whole-file wrapper and preserves procedural bodies', () => {
    expect(transactionalSql('BEGIN;\nSELECT 1;\nCOMMIT;')).toBe('\nSELECT 1;\n');
    expect(transactionalSql('DO $$\nBEGIN\nNULL;\nEND $$;')).toContain('BEGIN');
    expect(() => transactionalSql('SELECT 1;\nCOMMIT;')).toThrow();
    expect(schemaIdentity([{name:'a',sql:'SELECT 1;'}])).toBe(schemaIdentity([{name:'a',sql:'SELECT 1;'}]));
    expect(schemaIdentity([{name:'a',sql:'SELECT 1;'}])).not.toBe(schemaIdentity([{name:'a',sql:'SELECT 2;'}]));
  });
});
