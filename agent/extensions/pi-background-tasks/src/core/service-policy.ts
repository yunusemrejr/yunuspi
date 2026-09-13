/** Recognize common persistent servers at shell command positions, not names or
 * arbitrary mentions in echo/grep arguments. Unknown commands remain finite work. */
export function isPersistentService(command: string): boolean {
  const executableText = command.replace(/'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]/g, match => " ".repeat(match.length));
  return /(?:^|[;&|\n])\s*(?:exec\s+)?(?:php(?:\d+(?:\.\d+)*)?\s+-S\s|python(?:3(?:\.\d+)?)?\s+-m\s+http\.server(?:\s|$)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)(?:\s|$)|(?:npx\s+)?(?:vite(?:\s|$)|next\s+(?:dev|start)(?:\s|$)))/.test(executableText);
}

type CompletionPolicy = {
  command?: string;
  isAgent?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  triggerOnCompletionExplicit?: boolean;
};
export function serviceNotificationOnly(task: CompletionPolicy): boolean {
  return task.isAgent !== true && isPersistentService(task.command ?? "")
    && !(task.triggerOnCompletion === true && task.triggerOnCompletionExplicit === true);
}
export function taskTriggersCompletion(task: CompletionPolicy): boolean {
  return task.notifyOnCompletion === true && task.triggerOnCompletion === true && !serviceNotificationOnly(task);
}
export function defaultCompletionTrigger(command: string, isAgent: boolean, requested?: boolean): boolean {
  return requested ?? (isAgent || !isPersistentService(command));
}
