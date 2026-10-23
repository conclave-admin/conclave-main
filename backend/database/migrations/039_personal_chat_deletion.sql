-- Personal list removal; future messages make the conversation visible again.
ALTER TABLE room_member_preferences ADD COLUMN hidden_sequence BIGINT;
