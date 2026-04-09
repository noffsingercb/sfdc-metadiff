trigger CaseTrigger on Case (before insert, before update, after update) {
    if (Trigger.isBefore && Trigger.isInsert) {
        for (Case c : Trigger.new) {
            if (c.Priority == null) {
                c.Priority = 'Medium';
            }
        }
    }
    
    if (Trigger.isAfter && Trigger.isUpdate) {
        Set<Id> escalatedIds = new Set<Id>();
        for (Case c : Trigger.new) {
            if (c.Priority == 'High' && Trigger.oldMap.get(c.Id).Priority != 'High') {
                escalatedIds.add(c.Id);
            }
        }
        if (!escalatedIds.isEmpty()) {
            List<Case> toEscalate = [SELECT Id, Status, Priority, CreatedDate, AccountId
                                      FROM Case WHERE Id IN :escalatedIds];
            System.enqueueJob(new CaseEscalationHandler(toEscalate));
        }
    }
}