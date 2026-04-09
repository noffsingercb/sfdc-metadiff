/**
 * Handles escalation logic for high-priority Cases.
 * Called from Case trigger and Process Builder.
 * Updated: Added rule-based escalation and batch support.
 */
public with sharing class CaseEscalationHandler implements Queueable, Database.Stateful {

    private List<Case> cases;
    private Map<Id, EscalationRule__c> ruleCache;

    public CaseEscalationHandler(List<Case> cases) {
        this.cases = cases;
        this.ruleCache = new Map<Id, EscalationRule__c>();
    }

    public void execute(QueueableContext context) {
        loadRules();
        processCases();
    }

    public void processCases() {
        List<Case> toUpdate = new List<Case>();
        List<Escalation_Log__c> logs = new List<Escalation_Log__c>();
        
        for (Case c : cases) {
            if (isEligible(c, ruleCache.get(c.AccountId))) {
                c.Priority = 'High';
                c.OwnerId = getEscalationQueue();
                toUpdate.add(c);
                logs.add(new Escalation_Log__c(
                    Case__c = c.Id,
                    Escalated_Date__c = System.now()
                ));
            }
        }
        
        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
        if (!logs.isEmpty()) {
            insert logs;
        }
    }

    private void loadRules() {
        List<EscalationRule__c> rules = [SELECT Id, Threshold__c, Account__c 
                                          FROM EscalationRule__c 
                                          WHERE Active__c = true];
        for (EscalationRule__c r : rules) {
            ruleCache.put(r.Account__c, r);
        }
    }

    private Boolean isEligible(Case c, EscalationRule__c rule) {
        Integer threshold = (rule != null) ? Integer.valueOf(rule.Threshold__c) : 24;
        return c.Status == 'New' && c.CreatedDate < System.now().addHours(-threshold);
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

    @InvocableMethod(label='Escalate Cases' description='Escalates a list of cases based on rules')
    public static void handleEscalation(List<Id> caseIds) {
        List<Case> casesToProcess = [SELECT Id, Status, Priority, CreatedDate, AccountId
                                      FROM Case
                                      WHERE Id IN :caseIds];
        System.enqueueJob(new CaseEscalationHandler(casesToProcess));
    }
}