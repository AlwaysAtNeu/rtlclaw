#!/usr/bin/env node
/**
 * RTL-Claw CLI entry point.
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { getConfigManager } from './config/manager.js';
import { runSetup } from './config/setup.js';

const program = new Command();

program
  .name('rtl-claw')
  .description('AI-powered RTL development assistant')
  .version('0.1.0');

program
  .command('chat', { isDefault: true })
  .description('Start interactive session (default)')
  .option('-p, --project <path>', 'Open project at path')
  .option('-m, --model <model>', 'LLM model name')
  .option('--provider <provider>', 'LLM provider (openai, anthropic, ollama)')
  .option('--auto', 'Auto mode: skip confirmations')
  .action(async (opts: { project?: string; model?: string; provider?: string; auto?: boolean }) => {
    const config = getConfigManager();

    // First-run setup
    if (!config.isConfigured) {
      await runSetup(config);
    }

    // Apply CLI overrides
    if (opts.model) config.setLLM({ model: opts.model });
    if (opts.provider) config.setLLM({ provider: opts.provider as import('./config/schema.js').LLMProvider });
    if (opts.auto) config.set('autoMode', true);

    // Launch TUI
    const { startApp } = await import('./ui/app.js');
    await startApp(config, opts.project);
  });

program
  .command('config')
  .description('View or modify configuration')
  .option('--show', 'Show current configuration')
  .option('--reset', 'Reset to defaults')
  .option('--set <key=value>', 'Set a config value')
  .option('--setup', 'Re-run interactive setup')
  .action(async (opts: { show?: boolean; reset?: boolean; set?: string; setup?: boolean }) => {
    const config = getConfigManager();

    if (opts.setup) {
      await runSetup(config);
    } else if (opts.reset) {
      config.reset();
      console.log('✓ Configuration reset to defaults');
    } else if (opts.set) {
      const [key, value] = opts.set.split('=');
      if (key && value) {
        // Handle nested keys like llm.model
        const parts = key.split('.');
        if (parts.length === 2 && parts[0] === 'llm') {
          config.setLLM({ [parts[1]]: value } as Record<string, string>);
        } else {
          console.log(`Setting ${key} = ${value}`);
        }
        console.log(`✓ Set ${key} = ${value}`);
      }
    } else {
      // Default: show config
      console.log('Configuration file:', config.configPath);
      console.log(JSON.stringify(config.config, null, 2));
    }
  });

program
  .command('tools')
  .description('Show available EDA tools')
  .action(async () => {
    const { ToolRegistry } = await import('./tools/registry.js');
    const registry = new ToolRegistry();
    await registry.loadBuiltins();
    const tools = registry.getAll();

    console.log('\nEDA Tool Status:');
    console.log('─'.repeat(50));
    for (const tool of tools) {
      const icon = tool.available ? '●' : '○';
      const status = tool.available ? 'Available' : 'Not found';
      console.log(`  ${icon} ${tool.displayName.padEnd(25)} [${tool.category}] ${status}`);
    }
    console.log();
  });

program
  .command('project <action> [name]')
  .description('Manage projects (list, init, open)')
  .action(async (action: string, name?: string) => {
    const { ProjectManager } = await import('./project/manager.js');
    const config = getConfigManager();
    const pm = new ProjectManager();

    switch (action) {
      case 'list': {
        const projects = await pm.listProjects();
        if (projects.length === 0) {
          console.log('No projects found.');
        } else {
          console.log('\nProjects:');
          for (const p of projects) {
            console.log(`  ${p.name.padEnd(20)} ${p.rootPath}`);
          }
        }
        break;
      }
      case 'init': {
        const projectName = name ?? 'untitled';
        const rootPath = path.join(process.cwd(), projectName);
        const project = await pm.createProject(rootPath, projectName);
        console.log(`✓ Created project '${project.name}' at ${project.rootPath}`);
        break;
      }
      default:
        console.log(`Unknown action: ${action}. Use: list, init`);
    }
  });

program.parse();
