import type { TestProject } from "vitest/node";
import { createTestDatabase, testServerUrl } from "@kobe/db/testing";

declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = await createTestDatabase(testServerUrl());
  project.provide("adminUrl", db.adminUrl);
  project.provide("appUrl", db.appUrl);
  return db.drop;
}
