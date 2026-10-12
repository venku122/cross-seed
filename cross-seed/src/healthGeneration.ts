// Shared by configuration and metadata writers without importing health providers.
let generation = 0;

export function invalidateHealth(): void {
	generation++;
}

export function getHealthGeneration(): number {
	return generation;
}
