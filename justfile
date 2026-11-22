# Copyright 2026 Srikanth K.
# SPDX-License-Identifier: Apache-2.0

# Regenerate gen/ from buf.build/shokki-engineering/freebusy (needs protoc-gen-codemode on PATH).
generate:
    rm -rf gen
    buf generate

install:
    bun install

check: lint typecheck test

lint:
    bun run lint

typecheck:
    bun run typecheck

test:
    bun run test
    bun run test:node

demo:
    bun run demo
