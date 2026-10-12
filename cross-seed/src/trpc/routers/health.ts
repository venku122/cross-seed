import { authedProcedure, router } from "../index.js";
import { getHealth } from "../../health.js";
import { Label, logger } from "../../logger.js";

async function collectHealth(force = false) {
	try {
		return await getHealth(force);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error ?? "");
		logger.error({
			label: Label.SERVER,
			message: `Failed to collect health information: ${message}`,
		});
		throw new Error(`Failed to collect health information: ${message}`);
	}
}

export const healthRouter = router({
	get: authedProcedure.query(() => collectHealth()),
	refresh: authedProcedure.mutation(() => collectHealth(true)),
});
