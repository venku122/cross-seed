// Preserve adapter source identity while denying every live transport destination.
export function fixtureTransportDestination(input, clients) {
	const parsed = new URL(String(input));
	const sources = clients.map((client, index) => ({
		base: new URL(client.sourceLocator),
		index,
	}));
	if (sources.some(({ base }) => base.username || base.password))
		throw new Error("Source locators must omit credentials");
	const matches = sources.filter(
		({ base }) =>
			base.origin === parsed.origin &&
			parsed.pathname.startsWith(
				base.pathname.replace(/\/$/, "") + "/api/v2/",
			),
	);
	if (matches.length !== 1)
		throw new Error("Transport outside private fixture map rejected");
	return (
		"http://fixture:4041/source/" +
		matches[0].index +
		parsed.pathname.slice(parsed.pathname.indexOf("/api/v2")) +
		parsed.search
	);
}
