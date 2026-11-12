# Spec Delta

## Purpose

Administrators manage who has access to an install. This capability defines who is an administrator, what they can and cannot do to other people's access, and the record kept of what they did.

## ADDED Requirements

### Requirement: The install names its first administrators
The install's configuration SHALL name one or more email addresses as first administrators. A person who signs in with one of those addresses SHALL be an administrator; nobody else SHALL become one except through an administrator's action.

#### Scenario: Configured administrator signs in
- **WHEN** a person whose verified email address is named in the configuration signs in
- **THEN** they are an administrator and can open the administrators' page

#### Scenario: Anyone else opens the administrators' page
- **WHEN** a signed-in person who is not an administrator, or a visitor who is not signed in, requests the administrators' page or any of its actions
- **THEN** the request is refused and nothing about other people is shown

### Requirement: Administrators see who has access
The administrators' page SHALL list every person who has signed in, with their name, email address, whether they have access and whether they are an administrator. It SHALL NOT show requests, answers, rules, or when a person was last active.

#### Scenario: New person appears
- **WHEN** a person signs in for the first time
- **THEN** they appear in the list with access and without the administrator role

### Requirement: Administrators remove and restore access
An administrator SHALL be able to remove a person's access and to restore it. Removal SHALL end that person's sessions at once and refuse their sign-in, consent and token refresh until access is restored; access tokens already issued expire at their own expiry (one hour at most). The person's record SHALL be kept.

#### Scenario: Access removed
- **WHEN** an administrator removes a person's access
- **THEN** that person's sessions end, their next sign-in at the provider is refused by A2H with a page telling them to contact an administrator, and their clients' refreshes are refused

#### Scenario: Access restored
- **WHEN** an administrator restores that person's access
- **THEN** the person can sign in again and their earlier consents work again without being given anew

#### Scenario: Access of an administrator removed
- **WHEN** an administrator removes the access of another administrator, including one named in the configuration
- **THEN** that person loses access and is not an administrator while their access is removed, unless they are the last remaining administrator, in which case the action is refused

#### Scenario: Administrator removes their own access
- **WHEN** an administrator tries to remove their own access
- **THEN** the action is refused

### Requirement: Administrators name other administrators
An administrator SHALL be able to make another person with access an administrator and to withdraw that role. The role of the last remaining administrator SHALL NOT be withdrawn, and a person named in the configuration SHALL remain an administrator while the configuration names them and they have access. Only administrators who have signed in and have access count as remaining.

#### Scenario: Role granted
- **WHEN** an administrator makes another person an administrator
- **THEN** that person can open the administrators' page at their next request

#### Scenario: Last administrator
- **WHEN** withdrawing a role would leave the install with no administrator
- **THEN** the action is refused with an explanation

### Requirement: Administrator actions are recorded
Every removal, restoration, grant and withdrawal SHALL be recorded with who did it, to whom and when, in a record that cannot be edited and that every administrator can read.

#### Scenario: Action recorded
- **WHEN** an administrator removes a person's access
- **THEN** the record shows the administrator, the person, the action and the time, and no administrator can change or delete that entry

#### Scenario: Refused action leaves no change
- **WHEN** an action is refused (own access, last administrator)
- **THEN** nothing changes and no entry claims that it happened
