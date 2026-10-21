# Spec Delta

## Purpose

The A2H MCP server is reachable by any MCP client over Streamable HTTP without server-side session state, so that every protocol tool added later rides on one verified transport.

## ADDED Requirements

### Requirement: MCP endpoint answers over Streamable HTTP
The MCP server SHALL expose a single Streamable HTTP endpoint that accepts MCP JSON-RPC requests and returns responses per the MCP specification, without requiring a prior session.

#### Scenario: Initialize from a fresh client
- **WHEN** an MCP client sends `initialize` to the endpoint with no session header
- **THEN** the server responds with its capabilities and the protocol version it supports

#### Scenario: Tools are listed
- **WHEN** an initialized client sends `tools/list`
- **THEN** the response includes a tool named `ping` with a description and an input schema

### Requirement: ping tool round-trips
The MCP server SHALL provide a `ping` tool that returns a text result containing `pong` and the server's stage name.

#### Scenario: ping is called
- **WHEN** a client calls `tools/call` with name `ping` and no arguments
- **THEN** the result contains a text content item starting with `pong` and is not marked as an error

### Requirement: Endpoint is stateless across instances
The MCP server SHALL serve any request on any instance; it MUST NOT depend on in-memory state from an earlier request to answer a later one.

#### Scenario: Requests hit different instances
- **WHEN** two consecutive requests from the same client are served by two different server instances
- **THEN** both are answered correctly

### Requirement: Health endpoint for the load balancer
The MCP server SHALL expose an unauthenticated health path that returns success only when the process can serve MCP requests.

#### Scenario: Load balancer probes health
- **WHEN** the health path is requested
- **THEN** it returns HTTP 200 within one second and no MCP state is created

### Requirement: Long-lived streams are not cut by infrastructure
The deployment SHALL keep an idle streaming response open for at least one hour.

#### Scenario: Idle stream survives
- **WHEN** a client opens a streaming response and sends nothing for 61 minutes
- **THEN** the connection is still open from the client's point of view
