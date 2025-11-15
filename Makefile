# Declare the dependencies of the factory on defindex
default: build

all: test

test: build
	cargo test

build: 
	cargo build --target wasm32v1-none --release

fmt:
	cargo fmt --all --check