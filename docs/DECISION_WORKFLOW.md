# Decision workflow

Decisions are records of a choice already made, not proposals or votes. Any member of a server-readable collaboration room may record one. The author and room admins may correct or retract it; every revision remains visible to current room members. Retraction removes its room pin and appears in catch-up. Cards name the person who recorded the choice.

Encrypted conversations cannot create shared decisions because this API stores searchable plaintext. The client explains that boundary. A future encrypted decision workflow needs its own device-side content, key distribution, search and recovery design before it is enabled.

The creator supplies a stable `clientId` for retries. The API returns the first committed decision for that author and ID. The client keeps an unfinished form in session storage and reuses the ID until creation succeeds. Apply migration `044_decision_reliability.sql` before deploying the API and client.

Room pin events contain identifiers only. A personal bookmark event goes only to the person's own sockets. Clients refetch pin and capability state for the current viewer. Room admins may remove a room pin; the API requires current membership for every shared pin change.

Decision creation, edits and retractions create per-member notification records, excluding the actor. Notification preference `decision` controls interruption. Catch-up uses the latest unseen revision so a change to an older decision is visible. Retraction does not erase downloaded or previously viewed copies.

## Follow-up work

Apply migration `047_decision_follow_up_tasks.sql` before deploying this upgrade. A task may reference one active decision in the same conversation. The database guards the room relationship, and the API verifies decision status and current membership when creating the task. A retracted decision keeps its existing tasks so the work history is not lost; no new follow-up may be attached to it.

Decision cards and the detail page show linked task progress. The detail page can create a follow-up task and open it on the task board. Task details link back to the originating decision. The assignee alone changes progress and posts work notes; the creator or room admin manages assignment and task details. `GET /decisions/overview` returns counts across the caller's conversations, and `GET /tasks?decisionId=` pages through linked tasks with the usual room membership check.
