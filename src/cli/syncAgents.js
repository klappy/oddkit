/**
 * CLI handler for sync-agents command
 *
 * Usage:
 *   oddkit sync-agents              # Dry-run (default)
 *   oddkit sync-agents --apply      # Actually copy files
 *   oddkit sync-agents --no-backup  # Skip backup on apply
 *   oddkit sync-agents --only odd-map-navigator,odd-mode-selector
 *   oddkit sync-agents --from baseline  # Force baseline refresh
 *   oddkit sync-agents --dest /path/to/agents
 */

import { runSyncAgents, getDefaultCursorAgentsDir } from "../tasks/syncAgents.js";

/**
 * Register sync-agents command with commander
 */
export function registerSyncAgentsCommand(program) {
  program
    .command("sync-agents")
    .description("Sync agent files from baseline to Cursor agents directory")
    .option("--apply", "Actually copy files (default is dry-run)")
    .option("--no-backup", "Skip creating backups when overwriting")
    .option("--only <agents>", "Comma-separated list of agent names to sync")
    .option("--from <source>", "Force baseline refresh before sync (use 'baseline')")
    .option(
      "--dest <path>",
      `Override destination directory (default: ${getDefaultCursorAgentsDir()})`,
    )
    .option("-v, --verbose", "Show detailed output including unchanged files")
    .action(async (options) => {
      try {
        // Parse --only into array
        const only = options.only ? options.only.split(",").map((s) => s.trim()) : null;

        // Check if baseline refresh requested
        const refreshBaseline = options.from === "baseline";

        const result = await runSyncAgents({
          apply: options.apply || false,
          backup: options.backup !== false, // --no-backup sets this to false
          only,
          refreshBaseline,
          dest: options.dest || null,
          verbose: options.verbose || false,
        });

        console.log(result.output);

        if (!result.ok) {
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
