declare module "@yunuspi/agent-core" {
	interface AgentToolResult<T> {
		/** Runtime error flag emitted and rendered by pi tool execution. */
		isError?: boolean;
	}
}

export {};
