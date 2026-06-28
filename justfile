set shell := ["bash", "-cu"]

install:
    npm install

build:
    npm run build

test:
    npm test

typecheck:
    npm run typecheck

check:
    npm run typecheck && npm test && npm run build

release version:
    #!/usr/bin/env bash
    set -euo pipefail
    npm version {{version}} --no-git-tag-version
    git add package.json package-lock.json 2>/dev/null || git add package.json
    git commit -m "release: v{{version}}"
    git tag "v{{version}}"
    git push origin master --tags
    echo "Pushed v{{version}} — CI will publish to npm"
