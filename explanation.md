#### Main Goals

- Components have only one interface with interacting with data regardless of online status
- Data is synced seamlessly without extra user interaction
- User never has to resolve data conflicts
- Data reliably stored


Example variables request
```json
{
  "inspection": {
    "areas": [
      {
        "name": "Kitchen",
        "timestamps": {
          "name": "00000000009rxzm:00000:my-client:v01"
        },
        "uuid": "4321-bcda"
      }
    ],
    "name": "My Inspection",
    "note": "Apartment was kinda smelly",
    "timestamps": {
      "name": "00000000009rxzm:00000:my-client:v01",
      "note": "00000000009rxzm:00000:my-client:v01"
    },
    "uuid": "abcd-1234"
  }
}
```
### Why patch mutation?
Don't have to worry about ordering of requests. Each request is self-contained and can be applied on its own.

How: Patches are built up through a custom `PatchExchange` that takes takes current cache state and merges it with a set of changed variables.
This allows for operations to be sent with only changed variables, but for resulting mutation to represent current state with changes.

### Why timestamp each field?
Ordering of when operations are received on server doesn't matter and changes from multiple machines are merged without conflicts. Last write to single field wins.

How: Timestamps added to mutations through a custom `TimestampExchange` so consumers never have to worry timestamps.

### Why use HLC's?
a) All events created on a single machine will be correctly ordered with respect to each other (even if local clock jumps)

b) Once machine A sends events to machine B, all events subsequently created on machine B will be ordered as after those events from machine A

https://jaredforsyth.com/posts/hybrid-logical-clocks/

### How are updates shown to user immediately?
Urql's Graphcache exchange can be configured to show optimistic updates for graphql mutations https://formidable.com/open-source/urql/docs/graphcache/cache-updates/#optimistic-updates

However, this is not perfect and there are several major limitations to work around as Graphcache is not truly designed to stack many mutations on top of each other (see below questions).

### Why custom offlineExchange?
The offlineExchange is a relatively simple wrapper around Graphcahce that holds onto retryable operations.

Graphcache's optimistic layer is reverted in its entirety if a single optimistic mutation comes back with an error.
To work around this we have to: 
* Don't let retryable errors (ex: APM api down) make it to graphcache 
* When a genuine error is returned (ie. bad mutation) we have to
  * let that error hit graphcache and have it clear the optimistic layer
  * re-execute other mutations to re-create the optimistic layer

Additionally, a custom offlineExchange is required because urql's exchange only stores mutations once they have come back with a network error. We don't want to drop mutations if the app is closed just because they haven't returned yet.

### Why is batching/stacking mutations required?
When offline each mutation is stored and when client comes online (or is restarted) all mutations are applied again. 
This could be 100s of mutations sent at once and could overwhelm the server.

#### Why are locally generated UUID's required?
Client needs to be able to generate data that will look the same as what the server will return. Having an unknown ID 
makes this very hard, especially if editing things.
