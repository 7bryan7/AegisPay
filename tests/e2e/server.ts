import { createApApp } from "../../apps/server/src/ap/app.js";
import { createFixtureStore, fixtureConfig } from "../support/ap-fixture.js";

// Dedicated test process, no database/client credentials and no payment adapter.
createApApp(fixtureConfig, createFixtureStore()).listen(4100, "127.0.0.1");
