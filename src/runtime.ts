// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import { type CodemodeRuntime, createCodemode, type Store } from "@the-protobuf-project/codemode";
import { QuickJSExecutor } from "@the-protobuf-project/codemode/quickjs";
import { catalog, config, connectors, type Services } from "../gen/index.ts";

/** Code Mode over freebusy: the generated catalog, the policy from codemode.yaml, and a QuickJS sandbox. */
export function freebusyCodemode(services: Services, store?: Store): CodemodeRuntime {
  return createCodemode({
    catalog,
    config,
    connectors: connectors(services),
    executor: new QuickJSExecutor(),
    ...(store ? { store } : {}),
  });
}
