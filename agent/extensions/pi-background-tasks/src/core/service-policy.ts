/** Recognize common persistent servers at shell command positions, not names or
 * arbitrary mentions in echo/grep arguments. Unknown commands remain finite work. */
export function isPersistentService(command: string): boolean {
  const executableText = command.replace(/'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]/g, match => " ".repeat(match.length));
  return /(?:^|[;&|\n])\s*(?:exec\s+)?(?:php(?:\d+(?:\.\d+)*)?\s+-S\s|python(?:3(?:\.\d+)?)?\s+-m\s+http\.server(?:\s|$)|(?:uvicorn|gunicorn|hypercorn|http-server|live-server)(?:\s|$)|flask\s+run(?:\s|$)|rails\s+s(?:erver)?(?:\s|$)|(?:npx\s+)?serve\s|webpack\s+serve(?:\s|$)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)(?:\s|$)|(?:npx\s+)?(?:vite(?:\s|$)|next\s+(?:dev|start)(?:\s|$)))/.test(executableText);
}

/** The TCP port a service command binds, when the command states it. */
export function servicePort(command: string): number | undefined {
  const match = /(?:--port[ =]|(?:^|\s)-p\s+|\bPORT=|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):)(\d{2,5})\b/.exec(command);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

type CompletionPolicy = {
  command?: string;
  service?: boolean;
  isAgent?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  triggerOnCompletionExplicit?: boolean;
};
export function serviceNotificationOnly(task: CompletionPolicy): boolean {
  return task.isAgent !== true && (task.service === true || isPersistentService(task.command ?? ""))
    && !(task.triggerOnCompletion === true && task.triggerOnCompletionExplicit === true);
}
export function taskTriggersCompletion(task: CompletionPolicy): boolean {
  return task.notifyOnCompletion === true && task.triggerOnCompletion === true && !serviceNotificationOnly(task);
}
export function defaultCompletionTrigger(command: string, isAgent: boolean, requested?: boolean, service?: boolean): boolean {
  return requested ?? (isAgent || service !== true && !isPersistentService(command));
}
