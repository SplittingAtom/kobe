/** Fixed lowercase UUIDs for fixtures (Kobe-minted ids are Postgres uuids). */
export const EXAMPLE_IDS = {
  team: "0b6f1c2e-6d1a-4c56-9a43-1f0e2d3c4b5a",
  otherTeam: "9e8d7c6b-5a49-4382-b170-6f5e4d3c2b1a",
  user: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  thread: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60",
  run: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071",
  approval: "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f607182",
  agent: "5a6b7c8d-9e0f-4a1b-8c3d-4e5f60718293",
  artifact: "6b7c8d9e-0f1a-4b2c-9d4e-5f60718293a4",
  file: "7c8d9e0f-1a2b-4c3d-8e5f-60718293a4b5",
  memory: "8d9e0f1a-2b3c-4d4e-9f60-718293a4b5c6",
  connector: "9e0f1a2b-3c4d-4e5f-8071-8293a4b5c6d7",
  sandbox: "af1a2b3c-4d5e-4f60-9182-93a4b5c6d7e8",
} as const;
