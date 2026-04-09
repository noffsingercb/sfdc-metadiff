trigger CaseTrigger on Case (before insert, before update) {
    if (Trigger.isBefore && Trigger.isInsert) {
        for (Case c : Trigger.new) {
            if (c.Priority == null) {
                c.Priority = 'Medium';
            }
        }
    }
}