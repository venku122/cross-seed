// Match logical data visibility while keeping the raw legacy backup intact.
// A hidden owner cannot conceal another enabled, visible owner of the same path.
export const VISIBLE_DATA_SQL = `SELECT d.path,d.title FROM data AS d
WHERE d.path IS NULL OR d.path NOT IN (
 SELECT json_extract(o.metadata,'$.path') FROM source_origin AS o
 JOIN source_namespace AS ns ON ns.id=o.namespace_id
 WHERE (ns.enabled=0 OR o.state IN ('unavailable','removed','superseded'))
 AND json_extract(o.metadata,'$.path') IS NOT NULL
 AND NOT EXISTS (
  SELECT 1 FROM source_origin AS active
  JOIN source_namespace AS active_ns ON active_ns.id=active.namespace_id
  WHERE active_ns.enabled=1 AND active.state IN ('verified','legacy-unknown')
  AND json_extract(active.metadata,'$.path')=json_extract(o.metadata,'$.path')
 )
)`;

// Checked harness-only transformations. The original fixture and compiled app
// execution remain pinned; no application source is changed by this adapter.
export function adaptWorker(original) {
	let source = original;
	function replace(before, after) {
		if (source.split(before).length !== 2)
			throw new Error("Pinned worker anchor changed");
		source = source.replace(before, after);
	}
	const catalogStart = source.indexOf('\tconst aliases = ["Alpha"');
	const fetchEnd = source.indexOf(
		"\tconst { setClientsForTesting }",
		catalogStart,
	);
	if (catalogStart < 0 || fetchEnd < 0)
		throw new Error("Pinned transport anchors changed");
	source =
		source.slice(0, catalogStart) +
		`\tconst originalFetch = globalThis.fetch;
 globalThis.fetch = async (url, options={}) => {
  const parsed = new URL(String(url));
  if(parsed.hostname !== 'qb-fixture.invalid') return originalFetch(url,options);
  const route=parsed.pathname.replace('/api/v2','');
  adapter.routes[route]=(adapter.routes[route]??0)+1;
  adapter.requestBytes+=Buffer.byteLength(String(options.body??''));
  if(route === '/torrents/info') { refreshCalls++; refreshedSearchees+=count; }
  const response=await originalFetch(process.env.QB_ORIGIN+parsed.pathname+parsed.search,options);
  // Read actual wire bytes; JSON parsing remains in the daemon adapter.
  const bytes=await response.arrayBuffer(); adapter.responseBytes+=bytes.byteLength;
  return new Response(bytes,{status:response.status,headers:response.headers});
 };
` +
		source.slice(fetchEnd);
	replace(
		'db.client.connectionSettings.filename = ":memory:";',
		'db.client.connectionSettings.filename = join(configDir,"benchmark.db");',
	);
	const pingStart = source.indexOf("\tconst ping = fork(");
	const pingEnd = source.indexOf("\tlet sqlCalls = 0;", pingStart);
	if (pingStart < 0 || pingEnd < 0)
		throw new Error("Pinned ping anchors changed");
	source =
		source.slice(0, pingStart) +
		` const control=async(type,body={}) => {
  const response=await originalFetch(process.env.LOAD_CONTROL+'/'+type,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok) throw new Error('External load control failed');
  return response.json();
 };
 await control('arm',{url:'http://'+(process.env.PING_HOST??'127.0.0.1')+':'+port+'/api/ping'});
` +
		source.slice(pingEnd);
	replace(
		'\tawait new Promise((done) => {\n\t\tping.once("message", done);\n\t\tping.send("begin");\n\t});',
		'\tawait control("begin");',
	);
	// Stop before untimed diagnostic SQL and delayed event-loop observation.
	replace(
		"\tconst cpu = process.cpuUsage(cpuStart);",
		'\tconst cpu = process.cpuUsage(cpuStart);\n const externalHttp = await control("stop");',
	);
	replace(
		'\tping.send("stop");\n\tconst http = await pingResult;',
		"\tconst http = externalHttp;",
	);
	replace(
		"warm migrated in-memory SQLite and synthetic fetch/filesystem transport; prepared source catalog outside timing, transport JSON encode/decode inside timing",
		"disposable file-backed SQLite; external pre-serialized fake qB and open-loop HTTP generator; synthetic filesystem; daemon-side transport decode inside timing",
	);

	replace(
		"const root = resolve(checkout);",
		`const root = resolve(checkout);
 const ownedStore = fs.existsSync(join(root,'cross-seed/dist/sourceStore.js'));`,
	);
	replace(
		'url ===\n\t\t\t\tpathToFileURL(join(root, "cross-seed/dist/torrent.js")).href',
		'!ownedStore && url ===\n\t\t\t\tpathToFileURL(join(root, "cross-seed/dist/torrent.js")).href',
	);
	replace(
		"\tconst plans = await db.raw(",
		`
 // Import fixture legacy rows after every synthetic write, outside timing.
 let ownedQuery;
 if(ownedStore) {
  const migration = await importSource('migrations/19-source-ownership');
  await migration.default.up(db);
  ownedQuery = (await importSource('sourceStore')).sourceMembershipQuery;
 }
 const legacyDigest = async () => createHash('sha256').update(JSON.stringify(await db('ensemble').select('*').orderByRaw('rowid'))).digest('hex');
 const legacyBefore = ownedStore ? await legacyDigest() : null;
\tconst plans = await db.raw(`,
	);
	replace(
		'await db("ensemble").count("* as n");',
		'await db(ownedStore ? "ensemble_membership" : "ensemble").count("* as n");',
	);
	const digestStart = source.indexOf(
		'\tfor (const row of await db("ensemble")\n\t\t.select("client_host"',
	);
	const digestEnd = source.indexOf("\tconst dataDigest =", digestStart);
	if (digestStart < 0 || digestEnd < 0)
		throw new Error("Pinned digest anchors changed");
	source =
		source.slice(0, digestStart) +
		`
 const membershipRows = ownedStore
  ? (await ownedQuery(db).orderBy('m.selection_order')).map(({client_host,path,info_hash,ensemble,element})=>({client_host,path,info_hash,ensemble,element}))
  : await db('ensemble').select('client_host','path','info_hash','ensemble','element').orderByRaw('rowid');
 for(const row of membershipRows) digest.update(JSON.stringify(row)+'\\n');
 const membershipSelectionDigest = digest.digest('hex');
 const semanticRows=[...new Set(membershipRows.map(row=>JSON.stringify(row)))].sort();
 const membershipDigest=createHash('sha256').update(semanticRows.join('\\n')).digest('hex');
 const legacyAfter=ownedStore ? await legacyDigest() : null;
 if(ownedStore && legacyBefore!==legacyAfter) throw new Error('Preserved legacy table changed');
 ` +
		source.slice(digestEnd);
	replace(
		'for (const row of cacheRows) cacheDigest.update(JSON.stringify(row) + "\\n");',
		`for (const row of cacheRows) {
   const compatible = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'source_namespace_id'));
   cacheDigest.update(JSON.stringify(compatible) + "\\n");
  }`,
	);

	replace(
		'const remainingEnsemble = await db("ensemble").count({ n: "*" }).first();',
		"const remainingEnsemble = { n: membershipRows.length };",
	);
	replace(
		"globalThis.__combinedPerf.generatedSources !== count * repeats ||",
		"!ownedStore && (globalThis.__combinedPerf.generatedSources !== count * repeats ||",
	);
	replace(
		"count * memberships * repeats\n\t)",
		"count * memberships * repeats)\n\t)",
	);
	replace(
		"\t\tmembershipDigest,",
		"\t\tmembershipDigest,\n membershipSelectionDigest, membershipSample: membershipRows.slice(0,3), legacyBefore, legacyAfter, ownedStore, ownedMembershipRows: ownedStore ? membershipRows.length : null,",
	);
	replace(
		'for (const row of await db("data").select("path", "title").orderBy("path"))',
		`for (const row of await visibleData().select("path", "title").orderBy("path"))`,
	);
	replace(
		'\tconst dataDigest = crypto.createHash("sha256");',
		`const visibleData = () => ownedStore ? db().from(db.raw(${JSON.stringify("(" + VISIBLE_DATA_SQL + ") AS visible_data")})) : db('data');
\tconst dataDigest = crypto.createHash("sha256");`,
	);
	replace(
		'const remainingData = await db("data").count({ n: "*" }).first();',
		`const remainingData = await visibleData().count({ n: "*" }).first();
 const rawDataRows = Number((await db('data').count({n:'*'}).first()).n);
 const rawLegacyMembershipRows = Number((await db('ensemble').count({n:'*'}).first()).n);
 const rawOwnedMembershipRows = ownedStore ? Number((await db('ensemble_membership').count({n:'*'}).first()).n) : null;`,
	);
	replace(
		"\t\tremainingData: remainingData.n,",
		"\t\tremainingData: remainingData.n,\n rawDataRows, rawLegacyMembershipRows, rawOwnedMembershipRows,",
	);
	replace(
		"const pre = process.memoryUsage();",
		`const {createActiveProfiler} = await import(new URL('./profiling.mjs', import.meta.url));
 const activeProfiler = createActiveProfiler(process.env.BENCH_PROFILE === '1');
 const pre = process.memoryUsage();`,
	);
	replace(
		"const cpuStart = process.cpuUsage();",
		"activeProfiler.begin();\n const cpuStart = process.cpuUsage();",
	);
	replace(
		'const externalHttp = await control("stop");',
		'const profiling = await activeProfiler.end();\n const externalHttp = await control("stop");',
	);
	replace("\t\thttp,", "\t\thttp,\n profiling,");
	replace("referenceMergePlan: plans,", "legacyReferenceMergePlan: plans,");
	return source;
}
