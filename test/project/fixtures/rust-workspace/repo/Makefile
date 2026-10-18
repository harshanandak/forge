CARGO := cargo

.PHONY: test lint
test:
	$(CARGO) test --workspace
lint:
	$(CARGO) clippy
build release: 
	$(CARGO) build
