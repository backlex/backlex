part of backlex;

/// Handle for an active realtime subscription. [cancel] unsubscribes — the same
/// contract as the TS SDK's returned unsubscribe function.
class Subscription {
  bool _stopped = false;

  void cancel() {
    _stopped = true;
  }
}
