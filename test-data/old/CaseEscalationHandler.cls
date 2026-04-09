/**
 * Handles escalation logic for high-priority Cases.
 * Called from Case trigger and Process Builder.
 */
public with sharing class CaseEscalationHandler implements Queueable {

    private List<Case> cases;

    public CaseEscalationHandler(List<Case> cases) {
        this.cases = cases;
    }

    public void execute(QueueableContext context) {
        processCases();
    }

    public void processCases() {
        List<Case> toUpdate = new List<Case>();
        
        for (Case c : cases) {
            if (isEligible(c)) {
                c.Priority = 'High';
                c.OwnerId = getEscalationQueue();
                toUpdate.add(c);
            }
        }
        
        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
    }

    private Boolean isEligible(Case c) {
        return c.Status == 'New' && c.CreatedDate < System.now().addHours(-24);
    }

    private Id getEscalationQueue() {
        Group q = [SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = 'Escalation_Queue' LIMIT 1];
        return q.Id;
    }

    @AuraEnabled
    public static List<Case> getOpenEscalations() {
        return [SELECT Id, Subject, Priority, Status, OwnerId
                FROM Case
                WHERE Priority = 'High'
                AND Status != 'Closed'
                ORDER BY CreatedDate DESC];
    }
}