import { copyFile, stat, chmod } from "node:fs/promises";
// Only consistent standalone backups are accepted. Stage privately so SQLite
// may create WAL reader sidecars without ever writing to the RO snapshot volume.
export async function stageColdInput(source, destination) {
	try {
		if ((await stat(source + "-wal")).size > 0)
			throw new Error(
				"Snapshot has a nonempty WAL; require consistent standalone backup",
			);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await copyFile(source, destination);
	await chmod(destination, 0o600);
	return destination;
}
