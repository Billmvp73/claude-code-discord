import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import { CLAUDE_MODELS, CLAUDE_TEMPLATES, resolveModelId, readSdkSessions, type ModelInfo, type SdkSession } from "./enhanced-client.ts";
import { basename } from "https://deno.land/std@0.208.0/path/mod.ts";

export const enhancedClaudeCommands = [
  new SlashCommandBuilder()
    .setName('claude-enhanced')
    .setDescription('Send message to Claude Code with advanced options')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('model')
        .setDescription('Claude model to use')
        .setRequired(false)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('template')
        .setDescription('Use a predefined template')
        .setRequired(false)
        .addChoices(
          ...Object.entries(CLAUDE_TEMPLATES).map(([key, value]) => ({
            name: key.charAt(0).toUpperCase() + key.slice(1),
            value: key
          }))
        ))
    .addBooleanOption(option =>
      option.setName('include_system_info')
        .setDescription('Include system information in context')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('include_git_context')
        .setDescription('Include git repository context')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('context_files')
        .setDescription('Comma-separated list of files to include in context')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('session_id')
        .setDescription('Session ID to continue (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-models')
    .setDescription('List available Claude models and their capabilities'),

  new SlashCommandBuilder()
    .setName('claude-sessions')
    .setDescription('Manage Claude Code sessions')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('Action to perform')
        .setRequired(true)
        .addChoices(
          { name: 'list', value: 'list' },
          { name: 'info', value: 'info' },
          { name: 'delete', value: 'delete' },
          { name: 'cleanup', value: 'cleanup' }
        ))
    .addStringOption(option =>
      option.setName('session_id')
        .setDescription('Session ID (required for info/delete actions)')
        .setRequired(false)),

  // NOTE: claude-templates command removed as requested
  // Template functionality is now handled through enhanced prompting

  new SlashCommandBuilder()
    .setName('claude-context')
    .setDescription('Show context information that would be sent to Claude')
    .addBooleanOption(option =>
      option.setName('include_system_info')
        .setDescription('Include system information')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('include_git_context')
        .setDescription('Include git context')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('context_files')
        .setDescription('Comma-separated list of files to preview')
        .setRequired(false))
];

export interface EnhancedClaudeHandlerDeps {
  workDir: string;
  getClaudeController: () => AbortController | null;
  setClaudeController: (controller: AbortController | null) => void;
  setClaudeSessionId: (sessionId: string | undefined) => void;
  sendClaudeMessages: (messages: any[]) => Promise<void>;
  sessionManager: any;
  crashHandler: any;
  /** Get current runtime options from unified settings (thinking, operation, proxy) */
  getQueryOptions?: () => import("./client.ts").ClaudeModelOptions;
  resolveCwdForChannel?: (channelId: string, parentChannelId?: string) => string;
}

export function createEnhancedClaudeHandlers(deps: EnhancedClaudeHandlerDeps) {
  const { workDir, sessionManager, crashHandler, sendClaudeMessages } = deps;
  
  return {
    async onClaudeEnhanced(
      ctx: any,
      prompt: string,
      model?: string,
      template?: string,
      includeSystemInfo?: boolean,
      includeGitContext?: boolean,
      contextFiles?: string,
      sessionId?: string
    ) {
      try {
        // Cancel any existing session
        const existingController = deps.getClaudeController();
        if (existingController) {
          existingController.abort();
        }

        const controller = new AbortController();
        deps.setClaudeController(controller);

        await ctx.deferReply();

        // Apply template if specified
        let enhancedPrompt = prompt;
        if (template && CLAUDE_TEMPLATES[template as keyof typeof CLAUDE_TEMPLATES]) {
          const templateText = CLAUDE_TEMPLATES[template as keyof typeof CLAUDE_TEMPLATES];
          enhancedPrompt = `${templateText}\n\n${prompt}`;
        }

        // Parse context files
        const contextFilesList = contextFiles ? 
          contextFiles.split(',').map(f => f.trim()).filter(f => f.length > 0) : 
          undefined;

        await ctx.editReply({
          embeds: [{
            color: 0xffff00,
            title: '🤖 Enhanced Claude Code Running...',
            description: 'Processing with advanced options...',
            fields: [
              { name: 'Model', value: model || 'Default', inline: true },
              { name: 'Template', value: template || 'None', inline: true },
              { name: 'System Info', value: includeSystemInfo ? 'Yes' : 'No', inline: true },
              { name: 'Git Context', value: includeGitContext ? 'Yes' : 'No', inline: true },
              { name: 'Context Files', value: contextFilesList?.length ? `${contextFilesList.length} files` : 'None', inline: true },
              { name: 'Prompt Preview', value: `\`${enhancedPrompt.substring(0, 200)}${enhancedPrompt.length > 200 ? '...' : ''}\``, inline: false }
            ],
            timestamp: true
          }]
        });

        const { enhancedClaudeQuery } = await import("./enhanced-client.ts");

        // Get current runtime options from settings (thinking, operation, proxy)
        const runtimeOpts = deps.getQueryOptions?.() || {};

        const cwd = deps.resolveCwdForChannel?.(ctx.getChannelId?.() ?? '', ctx.getParentChannelId?.() ?? undefined) ?? workDir;

        const result = await enhancedClaudeQuery(
          enhancedPrompt,
          {
            workDir: cwd,
            model: model ? resolveModelId(model) : runtimeOpts.model,
            includeSystemInfo: !!includeSystemInfo,
            includeGitContext: !!includeGitContext,
            contextFiles: contextFilesList,
            permissionMode: runtimeOpts.permissionMode,
            thinking: runtimeOpts.thinking,
            effort: runtimeOpts.effort,
            maxBudgetUsd: runtimeOpts.maxBudgetUsd,
            extraEnv: runtimeOpts.extraEnv,
          },
          controller,
          sessionId,
          undefined,
          async (jsonData) => {
            const { convertToClaudeMessages } = await import("./message-converter.ts");
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              sendClaudeMessages(claudeMessages).catch(() => {});
            }
          },
          false
        );

        deps.setClaudeSessionId(result.sessionId);
        deps.setClaudeController(null);

        // Update session manager
        if (result.sessionId) {
          sessionManager.updateSession(result.sessionId, result.cost);
        }

        // Completion message is already sent via SDK streaming (result type → message-converter.ts)

        return result;
      } catch (error) {
        await crashHandler.reportCrash('claude', error instanceof Error ? error : new Error(String(error)), 'enhanced', 'Enhanced Claude query');
        throw error;
      }
    },

    async onClaudeModels(ctx: any) {
      // Group models by tier
      const tiers = { flagship: '🏆 Flagship', balanced: '⚡ Balanced', fast: '🚀 Fast', legacy: '📦 Legacy' };
      const grouped: Record<string, string[]> = { flagship: [], balanced: [], fast: [], legacy: [] };
      
      for (const [key, model] of Object.entries(CLAUDE_MODELS)) {
        const recommended = model.recommended ? ' ⭐' : '';
        const alias = model.aliasFor ? ` → \`${model.aliasFor}\`` : '';
        const deprecated = model.deprecated ? ' *(deprecated)*' : '';
        const entry = `**${model.name}${recommended}${deprecated}**\n${model.description}${alias}\nContext: ${model.contextWindow.toLocaleString()} tokens\nID: \`${key}\``;
        grouped[model.tier].push(entry);
      }
      
      const fields = Object.entries(tiers)
        .filter(([tier]) => grouped[tier].length > 0)
        .map(([tier, label]) => ({
          name: label,
          value: grouped[tier].join('\n\n'),
          inline: false
        }));

      await ctx.reply({
        embeds: [{
          color: 0x0099ff,
          title: '🤖 Available Claude Models',
          description: '⭐ = Recommended • Aliases (opus, sonnet, haiku) always resolve to the latest version',
          fields,
          footer: { text: 'Use any model ID or alias with /claude-enhanced or /settings' },
          timestamp: true
        }],
        ephemeral: true
      });
    },

    async onClaudeSessions(ctx: any, action: string, sessionId?: string) {
      try {
        switch (action) {
          case 'list': {
            const sessions = await readSdkSessions();
            if (sessions.length === 0) {
              await ctx.reply({
                embeds: [{
                  color: 0xffaa00,
                  title: '📋 Claude Sessions',
                  description: 'No active sessions found.',
                  timestamp: true
                }],
                ephemeral: true
              });
              return;
            }

            const sessionsList = sessions.map((s: SdkSession) => {
              const statusEmoji = s.status === 'busy' ? '🟢' : '⚪';
              const ago = formatDuration(Date.now() - s.updatedAt);
              return `\`${s.sessionId}\`\n**${s.name || 'unnamed'}** | ${basename(s.cwd)} | ${statusEmoji} ${s.status} | updated ${ago} ago`;
            }).join('\n\n');

            await ctx.reply({
              embeds: [{
                color: 0x00ff00,
                title: '📋 Active Claude Sessions',
                description: sessionsList,
                footer: { text: `Total: ${sessions.length} sessions` },
                timestamp: true
              }],
              ephemeral: true
            });
            break;
          }

          case 'info': {
            if (!sessionId) {
              await ctx.reply({
                content: 'Session ID is required for info action.',
                ephemeral: true
              });
              return;
            }

            const sessions = await readSdkSessions();
            const session = sessions.find((s: SdkSession) => s.sessionId === sessionId);
            if (!session) {
              await ctx.reply({
                content: 'Session not found. Use `/claude-sessions action:list` to see active sessions.',
                ephemeral: true
              });
              return;
            }

            const statusEmoji = session.status === 'busy' ? '🟢' : '⚪';

            await ctx.reply({
              embeds: [{
                color: 0x0099ff,
                title: '📊 Session Details',
                fields: [
                  { name: 'Session ID', value: `\`${session.sessionId}\``, inline: false },
                  { name: 'Name', value: session.name || 'unnamed', inline: true },
                  { name: 'Status', value: `${statusEmoji} ${session.status}`, inline: true },
                  { name: 'PID', value: session.pid.toString(), inline: true },
                  { name: 'Working Directory', value: `\`${session.cwd}\``, inline: false },
                  { name: 'Started', value: new Date(session.startedAt).toLocaleString(), inline: true },
                  { name: 'Last Updated', value: new Date(session.updatedAt).toLocaleString(), inline: true },
                  { name: 'Version', value: session.version || 'unknown', inline: true }
                ],
                timestamp: true
              }],
              ephemeral: true
            });
            break;
          }

          case 'delete': {
            await ctx.deferReply();
            await ctx.editReply({ embeds: [{ color: 0x808080, title: 'Session Management', description: 'Session lifecycle is managed by Claude Code — sessions close when their process exits.\nUse `/claude-cancel` to abort a running session.', timestamp: true }] });
            return;
          }

          case 'cleanup': {
            await ctx.deferReply();
            const sessions = await readSdkSessions();
            let removed = 0;
            let skipped = 0;
            for (const session of sessions) {
              try {
                Deno.kill(session.pid, 0);
                // If we get here without throwing, process is alive — skip
                skipped++;
              } catch (err) {
                if (err instanceof Deno.errors.NotFound) {
                  // Process is dead — remove stale file
                  try {
                    await Deno.remove(session._filePath);
                    removed++;
                  } catch { skipped++; }
                } else {
                  // PermissionDenied or other — treat as alive/unknown
                  skipped++;
                }
              }
            }
            await ctx.editReply({ embeds: [{ color: 0x00ff00, title: 'Session Cleanup', description: `Removed ${removed} stale session file(s). Skipped ${skipped} (alive or unknown).`, timestamp: true }] });
            break;
          }
        }
      } catch (error) {
        await crashHandler.reportCrash('main', error instanceof Error ? error : new Error(String(error)), 'claude-sessions', `Action: ${action}`);
        throw error;
      }
    },

    // NOTE: onClaudeTemplates handler removed as the claude-templates command was removed
    // Template functionality is now handled through the enhanced prompting system

    async onClaudeContext(
      ctx: any,
      includeSystemInfo?: boolean,
      includeGitContext?: boolean,
      contextFiles?: string
    ) {
      try {
        await ctx.deferReply({ ephemeral: true });

        const contextParts: string[] = [];

        if (includeSystemInfo) {
          try {
            const systemInfo = `System: ${Deno.build.os} ${Deno.build.arch}\nDeno: ${Deno.version.deno}\nWorking Directory: ${workDir}`;
            contextParts.push(`**System Information:**\n\`\`\`\n${systemInfo}\n\`\`\``);
          } catch (error) {
            contextParts.push(`**System Information:** Error - ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        if (includeGitContext) {
          try {
            const { executeGitCommand } = await import("../git/handler.ts");
            const cwd = deps.resolveCwdForChannel?.(ctx.getChannelId?.() ?? '', ctx.getParentChannelId?.() ?? undefined) ?? workDir;
            const [branch, status] = await Promise.all([
              executeGitCommand(cwd, "git branch --show-current"),
              executeGitCommand(cwd, "git status --porcelain")
            ]);

            const gitInfo = `Branch: ${branch.trim()}\nStatus: ${status || 'Clean'}`;
            contextParts.push(`**Git Context:**\n\`\`\`\n${gitInfo}\n\`\`\``);
          } catch (error) {
            contextParts.push(`**Git Context:** Error - ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        if (contextFiles) {
          const fileList = contextFiles.split(',').map(f => f.trim()).filter(f => f.length > 0);
          const fileContents: string[] = [];

          for (const filePath of fileList.slice(0, 5)) { // Limit to 5 files
            try {
              const content = await Deno.readTextFile(filePath);
              const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
              fileContents.push(`**${filePath}:**\n\`\`\`\n${preview}\n\`\`\``);
            } catch (error) {
              fileContents.push(`**${filePath}:** Error reading file`);
            }
          }

          if (fileList.length > 5) {
            fileContents.push(`**... and ${fileList.length - 5} more files**`);
          }

          contextParts.push(fileContents.join('\n\n'));
        }

        const fullContext = contextParts.join('\n\n');

        await ctx.editReply({
          embeds: [{
            color: 0x0099ff,
            title: '📋 Claude Context Preview',
            description: fullContext || 'No context selected. Enable options to see what would be included.',
            footer: { text: 'This is what would be sent to Claude as additional context' },
            timestamp: true
          }]
        });
      } catch (error) {
        await crashHandler.reportCrash('main', error instanceof Error ? error : new Error(String(error)), 'claude-context', 'Context preview');
        throw error;
      }
    }
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}