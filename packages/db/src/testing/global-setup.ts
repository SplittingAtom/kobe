import type { TestProject } from "vitest/node";
import { createTestDatabase, prepareTestLane, testServerUrl } from "../test-support/database.js";

declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
    ownerUrl: string;
    ownerRole: string;
    appUrl: string;
    appRole: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await prepareTestLane();
  const db = await createTestDatabase(testServerUrl());
  project.provide("adminUrl", db.adminUrl);
  project.provide("ownerUrl", db.ownerUrl);
  project.provide("ownerRole", db.ownerRole);
  project.provide("appUrl", db.appUrl);
  project.provide("appRole", db.appRole);
  return db.drop;
}
