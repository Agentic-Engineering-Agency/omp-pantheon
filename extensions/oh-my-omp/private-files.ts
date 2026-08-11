import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}
export async function assertNoSymlinkComponents(
	root: string,
	target: string,
): Promise<void> {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	const relativeTarget = relative(resolvedRoot, resolvedTarget);
	if (
		relativeTarget === ".." ||
		relativeTarget.startsWith(`..${sep}`) ||
		resolve(resolvedRoot, relativeTarget) !== resolvedTarget
	) {
		throw new Error("State path must stay within its configured root");
	}
	let current = resolvedRoot;
	for (const component of relativeTarget.split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new Error(`Refusing symbolic link in state path: ${current}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}


export async function appendPrivateFile(
	path: string,
	content: string,
): Promise<void> {
	await ensurePrivateDirectory(dirname(path));
	const handle = await open(path, "a", 0o600);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}
