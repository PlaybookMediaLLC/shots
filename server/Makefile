.PHONY: generate fmt fmt-check test race vet check build

# The packages whose tests run under the race detector. This list is the one
# source of truth: CI runs `make race`, so a package added here is covered
# locally and in CI at the same time. It used to be duplicated in ci.yml, where
# it had grown to sixteen packages while this file still named seven — a data
# race in any of the other nine passed `make check` and failed in CI.
RACE_PACKAGES := \
	./internal/agentclients \
	./internal/authstore \
	./internal/enrichment \
	./internal/httpapi \
	./internal/maintenance \
	./internal/mcp \
	./internal/notifications \
	./internal/onboarding \
	./internal/publishing \
	./internal/shotsapi \
	./internal/social/tenantpublishing \
	./internal/socialapi \
	./internal/socialconnect \
	./internal/temporalmaintenance \
	./internal/temporalonboarding \
	./internal/temporalpublishing

# `go test ./...` would run every race package's tests a second time, without
# the detector, against the one shared test database. Exclude them by their
# import path suffix.
RACE_PATH_PATTERN := $(subst $(subst ,, ),|,$(patsubst ./%,%,$(RACE_PACKAGES)))

generate:
	go generate ./ent ./internal/social/ent ./internal/frontenddeploy/vercelapi

fmt:
	gofmt -w .

fmt-check:
	@test -z "$$(gofmt -l .)" || { gofmt -l .; exit 1; }

test:
	go test $$(go list ./... | grep -Ev '/($(RACE_PATH_PATTERN))$$')

race:
	go test -race $(RACE_PACKAGES)

vet:
	go vet ./...

check: generate fmt-check test race vet
	git diff --exit-code -- ent internal/social/ent internal/frontenddeploy/vercelapi/client.gen.go
	# `go generate` runs with -mod=mod, which may rewrite the module graph.
	# An unreviewed dependency change is a supply-chain change.
	git diff --exit-code -- go.mod go.sum

build:
	go build ./cmd/...

# Everything the `go-checks` CI job runs that does not need a database.
# Kept here so a contributor can reproduce the job with one command.
ci-check: fmt-check vet
