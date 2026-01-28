import { Command } from 'commander';
import { runLibrarian } from './tasks/librarian.js';
import { runValidate } from './tasks/validate.js';
import { runIndex } from './tasks/indexTask.js';

export function run() {
  const program = new Command();

  program
    .name('oddkit')
    .description('Agent-first CLI for ODD-governed repos')
    .version('0.1.0');

  // Index command
  program
    .command('index')
    .description('Build or rebuild the document index')
    .option('-r, --repo <path>', 'Repository root path', process.cwd())
    .option('--force', 'Force rebuild even if index exists')
    .action(async (options) => {
      try {
        const result = await runIndex(options);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('Index error:', err.message);
        process.exit(1);
      }
    });

  // Librarian command
  program
    .command('librarian')
    .description('Ask a policy/lookup question')
    .requiredOption('-q, --query <text>', 'The question to ask')
    .option('-r, --repo <path>', 'Repository root path', process.cwd())
    .option('-f, --format <type>', 'Output format: json or md', 'json')
    .action(async (options) => {
      try {
        const result = await runLibrarian(options);
        if (options.format === 'md') {
          console.log(renderLibrarianMarkdown(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err) {
        console.error('Librarian error:', err.message);
        process.exit(1);
      }
    });

  // Validate command
  program
    .command('validate')
    .description('Validate a completion claim')
    .requiredOption('-m, --message <text>', 'The completion claim message')
    .option('-r, --repo <path>', 'Repository root path', process.cwd())
    .option('-a, --artifacts <path>', 'Path to artifacts JSON file')
    .option('-f, --format <type>', 'Output format: json or md', 'json')
    .action(async (options) => {
      try {
        const result = await runValidate(options);
        if (options.format === 'md') {
          console.log(renderValidateMarkdown(result));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err) {
        console.error('Validate error:', err.message);
        process.exit(1);
      }
    });

  program.parse();
}

function renderLibrarianMarkdown(result) {
  const lines = [];
  lines.push(`### Status`);
  lines.push(result.status);
  lines.push('');
  lines.push(`### Answer`);
  lines.push(result.answer);
  lines.push('');
  lines.push(`### Evidence`);
  for (const e of result.evidence) {
    lines.push(`- "${e.quote}" — \`${e.citation}\` (${e.origin})`);
  }
  if (result.read_next && result.read_next.length > 0) {
    lines.push('');
    lines.push(`### Read Next`);
    for (const r of result.read_next) {
      lines.push(`- \`${r.path}\` — ${r.reason}`);
    }
  }
  return lines.join('\n');
}

function renderValidateMarkdown(result) {
  const lines = [];
  lines.push(`### Verdict`);
  lines.push(result.verdict);
  lines.push('');
  lines.push(`### Claims`);
  for (const c of result.claims) {
    lines.push(`- ${c}`);
  }
  lines.push('');
  lines.push(`### Required Evidence`);
  for (const r of result.required_evidence) {
    lines.push(`- ${r}`);
  }
  lines.push('');
  lines.push(`### Provided Artifacts`);
  for (const p of result.provided_artifacts) {
    lines.push(`- ${p}`);
  }
  if (result.gaps.length > 0) {
    lines.push('');
    lines.push(`### Gaps`);
    for (const g of result.gaps) {
      lines.push(`- ${g}`);
    }
  }
  return lines.join('\n');
}
