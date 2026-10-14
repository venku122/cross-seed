// Initialize the generator's own fetch/keepalive path outside the active window.
const response = await fetch(process.argv[2]);
if (!response.ok || (await response.text()) !== "OK")
	throw new Error("Generator warmup ping failed");
await import("../loadgen.mjs");
