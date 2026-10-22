import { prepareTestLane } from "@kobe/db/testing";

/** Creates this run's test lane database (KOBE-482); test files create their own databases. */
export default async function setup(): Promise<void> {
  await prepareTestLane();
}
