/**
 * Supported fixtures for repository-level runtime verification.
 *
 * Kept separate from command APIs so scripts do not depend on private `dist`
 * paths that can change independently of the package export map.
 */
export { runCoordinatedFixture } from "./benchmark.js";
export { createBenchmarkFixture } from "./fixture.js";
export { OVERLAP_SCENARIO } from "./scenarios.js";
