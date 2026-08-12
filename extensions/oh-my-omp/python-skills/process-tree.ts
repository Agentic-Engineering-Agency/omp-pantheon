interface ProcessTreeHandle {
	readonly pid: number;
	readonly exited: Promise<number>;
	kill(signal?: number | string): void;
}

function processAlreadyExited(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ESRCH"
	);
}
function killDirectProcess(processHandle: ProcessTreeHandle): void {
	try {
		processHandle.kill("SIGKILL");
	} catch (error) {
		if (!processAlreadyExited(error)) throw error;
	}
}

export async function terminateProcessTree(
	processHandle: ProcessTreeHandle,
): Promise<void> {
	if (process.platform === "win32") {
		const taskkill = Bun.spawn({
			cmd: ["taskkill", "/PID", String(processHandle.pid), "/T", "/F"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await taskkill.exited;
		if (exitCode !== 0) {
			killDirectProcess(processHandle);
		}
	} else {
		try {
			process.kill(-processHandle.pid, "SIGKILL");
		} catch (error) {
			if (!processAlreadyExited(error)) {
				killDirectProcess(processHandle);
			}
		}
	}
	await processHandle.exited;
}
