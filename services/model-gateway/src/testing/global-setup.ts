import type { TestProject } from "vitest/node";
import { createTestDatabase, prepareTestLane, testServerUrl } from "@kobe/db/testing";

declare module "vitest" {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await prepareTestLane();
  const db = await createTestDatabase(testServerUrl());
  project.provide("ownerUrl", db.ownerUrl);
  project.provide("appUrl", db.appUrl);
  return db.drop;
}
