#!/usr/bin/env swift
import Contacts
import Foundation

private let maxInputBytes = 48 * 1024
private let maxPersonIds = 7
private let maxValues = 16
private let maxNameHandles = 128
private let maxVCardBytes = 2 * 1024 * 1024
private let maxVCardResponseBytes = 3 * 1024 * 1024
private let allowedId = try! NSRegularExpression(pattern: "^[A-Za-z0-9._:-]{1,200}$")
private let forbiddenDirectionals = Set<UInt32>(
    Array(0x202A...0x202E) + Array(0x2066...0x2069)
)

private struct LabeledValue: Decodable {
    let label: String
    let value: String
}

private struct PostalAddress: Decodable {
    let label: String
    let street: String
    let city: String
    let state: String
    let postalCode: String
    let country: String
    let countryCode: String
}

private struct Card: Decodable {
    let firstName: String
    let middleName: String
    let lastName: String
    let nickname: String
    let organization: String
    let department: String
    let jobTitle: String
    let birthday: String
    let note: String
    let phones: [LabeledValue]
    let emails: [LabeledValue]
    let urls: [LabeledValue]
    let addresses: [PostalAddress]
}

private struct Request: Decodable {
    let operation: String
    let personUids: [String]?
    let targetUid: String?
    let sourceUids: [String]?
    let card: Card?
    let handles: [String]?
}

private struct ResolvedName: Encodable {
    let handle: String
    let name: String
    let shortName: String
}

private struct CardCounts: Encodable {
    let uid: String
    let phones: Int
    let emails: Int
    let urls: Int
    let addresses: Int
}

private struct Response: Encodable {
    let ok: Bool
    let availableCount: Int?
    let deletedCount: Int?
    let updated: Bool?
    let error: String?
    let names: [ResolvedName]?
    // Failure stage, machine-readable: callers pick recovery per stage
    // instead of parsing the human message.
    var stage: String? = nil
    // "counts" op only: fresh CNContactStore collection sizes per card, the
    // staleness cross-check for Contacts.app's describe view.
    var counts: [CardCounts]? = nil
}

private struct VCardResponse: Encodable {
    let ok: Bool
    let name: String
    let vcard: String
}

private func failure(_ message: String, code: Int) -> NSError {
    NSError(domain: "BlipContacts", code: code,
            userInfo: [NSLocalizedDescriptionKey: message])
}

private func emit<T: Encodable>(_ response: T, maximum: Int = 4096) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(response), data.count <= maximum else {
        FileHandle.standardOutput.write(Data("{\"error\":\"Contacts mutation response failed\",\"ok\":false}".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
}

private func boundedInput() throws -> Data {
    var result = Data()
    while true {
        let chunk = try FileHandle.standardInput.read(upToCount: 4096) ?? Data()
        if chunk.isEmpty { return result }
        if result.count + chunk.count > maxInputBytes {
            throw failure("Contacts mutation request is too large", code: 1)
        }
        result.append(chunk)
    }
}

private func validId(_ identifier: String) -> Bool {
    let range = NSRange(identifier.startIndex..<identifier.endIndex, in: identifier)
    return allowedId.firstMatch(in: identifier, range: range)?.range == range
}

private func validateIds(_ identifiers: [String], minimum: Int = 1,
                         maximum: Int = maxPersonIds) throws {
    guard identifiers.count >= minimum, identifiers.count <= maximum,
          Set(identifiers).count == identifiers.count else {
        throw failure("Contacts mutation card list is invalid", code: 2)
    }
    guard identifiers.allSatisfy(validId) else {
        throw failure("Contacts mutation card id is invalid", code: 3)
    }
}

private func validateText(_ value: String, maximum: Int, required: Bool = false) throws {
    guard value.count <= maximum, (!required || !value.isEmpty),
          value.unicodeScalars.allSatisfy({
              !CharacterSet.controlCharacters.contains($0)
                  && !forbiddenDirectionals.contains($0.value)
          }) else {
        throw failure("Contacts mutation contains an invalid field", code: 4)
    }
}

private func resolvedNames(_ handles: [String], in store: CNContactStore) throws -> [ResolvedName] {
    guard !handles.isEmpty, handles.count <= maxNameHandles,
          Set(handles).count == handles.count else {
        throw failure("Contacts name request is invalid", code: 21)
    }
    let keys: [CNKeyDescriptor] = [
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        CNContactNicknameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
    ]
    func normalized(_ value: String) -> String {
        if value.contains("@") { return value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        let digits = value.filter(\.isNumber)
        return digits.count >= 10 ? String(digits.suffix(10)) : digits
    }
    var wanted: [String: String] = [:]
    for handle in handles where wanted[normalized(handle)] == nil {
        wanted[normalized(handle)] = handle
    }
    var found: [String: ResolvedName] = [:]
    let request = CNContactFetchRequest(keysToFetch: keys)
    request.unifyResults = true
    try store.enumerateContacts(with: request) { contact, _ in
        let keys = contact.phoneNumbers.map { normalized($0.value.stringValue) }
            + contact.emailAddresses.map { normalized($0.value as String) }
        let hits = Set(keys).intersection(wanted.keys)
        if hits.isEmpty { return }
        let formatted = CNContactFormatter.string(from: contact, style: .fullName) ?? ""
        let full = !formatted.isEmpty ? formatted
            : (!contact.organizationName.isEmpty ? contact.organizationName : contact.nickname)
        if full.isEmpty { return }
        let short = !contact.givenName.isEmpty ? contact.givenName
            : (!contact.nickname.isEmpty ? contact.nickname : full)
        for key in hits where found[key] == nil {
            found[key] = ResolvedName(handle: wanted[key]!, name: full, shortName: short)
        }
    }
    var result: [ResolvedName] = []
    for handle in handles {
        try validateText(handle, maximum: 320, required: true)
        if let name = found[normalized(handle)] {
            result.append(ResolvedName(handle: handle, name: name.name, shortName: name.shortName))
        }
    }
    return result
}

private func validateLabeled(_ values: [LabeledValue]) throws {
    guard values.count <= maxValues else {
        throw failure("Contacts mutation has too many field values", code: 5)
    }
    for item in values {
        try validateText(item.label, maximum: 80)
        try validateText(item.value, maximum: 320, required: true)
    }
}

private func validateCard(_ card: Card) throws {
    for value in [card.firstName, card.middleName, card.lastName, card.nickname] {
        try validateText(value, maximum: 160)
    }
    for value in [card.organization, card.department, card.jobTitle] {
        try validateText(value, maximum: 320)
    }
    try validateText(card.birthday, maximum: 10)
    try validateText(card.note, maximum: 1000)
    guard !card.firstName.isEmpty || !card.lastName.isEmpty
            || !card.nickname.isEmpty || !card.organization.isEmpty else {
        throw failure("Contact needs a name, nickname, or organization", code: 6)
    }
    try validateLabeled(card.phones)
    try validateLabeled(card.emails)
    try validateLabeled(card.urls)
    guard card.addresses.count <= maxValues else {
        throw failure("Contacts mutation has too many postal addresses", code: 7)
    }
    for address in card.addresses {
        try validateText(address.label, maximum: 80)
        try validateText(address.street, maximum: 320)
        try validateText(address.city, maximum: 320)
        try validateText(address.state, maximum: 320)
        try validateText(address.postalCode, maximum: 80)
        try validateText(address.country, maximum: 160)
        try validateText(address.countryCode, maximum: 8)
        guard !address.street.isEmpty || !address.city.isEmpty || !address.state.isEmpty
                || !address.postalCode.isEmpty || !address.country.isEmpty else {
            throw failure("Contacts mutation contains an empty postal address", code: 8)
        }
    }
}

private let mutationKeys: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactGivenNameKey as CNKeyDescriptor,
    CNContactMiddleNameKey as CNKeyDescriptor,
    CNContactFamilyNameKey as CNKeyDescriptor,
    CNContactNicknameKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactDepartmentNameKey as CNKeyDescriptor,
    CNContactJobTitleKey as CNKeyDescriptor,
    CNContactBirthdayKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactUrlAddressesKey as CNKeyDescriptor,
    CNContactPostalAddressesKey as CNKeyDescriptor
]

private func exactContacts(_ identifiers: [String], in store: CNContactStore,
                           keys: [CNKeyDescriptor]) throws -> [CNContact] {
    let request = CNContactFetchRequest(keysToFetch: keys)
    request.predicate = CNContact.predicateForContacts(withIdentifiers: identifiers)
    request.unifyResults = false
    var byIdentifier: [String: CNContact] = [:]
    try store.enumerateContacts(with: request) { contact, _ in
        guard identifiers.contains(contact.identifier), byIdentifier[contact.identifier] == nil else {
            return
        }
        byIdentifier[contact.identifier] = contact
    }
    return identifiers.compactMap { byIdentifier[$0] }
}

private func exactContact(_ identifier: String, in store: CNContactStore,
                          keys: [CNKeyDescriptor]) throws -> CNContact {
    let contacts = try exactContacts([identifier], in: store, keys: keys)
    guard contacts.count == 1, contacts[0].identifier == identifier else {
        throw failure("A selected Contacts source card no longer exists", code: 9)
    }
    return contacts[0]
}

private func containerIdentifier(for contact: CNContact, in store: CNContactStore) throws -> String {
    let predicate = CNContainer.predicateForContainerOfContact(withIdentifier: contact.identifier)
    let containers = try store.containers(matching: predicate)
    guard containers.count == 1 else {
        throw failure("Contacts could not identify a selected card's account", code: 20)
    }
    return containers[0].identifier
}

private func requireMissing(_ identifiers: [String], in store: CNContactStore) throws {
    let remaining = try exactContacts(
        identifiers, in: store, keys: [CNContactIdentifierKey as CNKeyDescriptor]
    )
    if !remaining.isEmpty {
        throw failure("Contacts did not delete every selected source card", code: 19)
    }
}

private func dateComponents(_ value: String) throws -> DateComponents? {
    if value.isEmpty { return nil }
    let yearless = value.hasPrefix("--")
    let pattern = yearless ? "^--[0-9]{2}-[0-9]{2}$" : "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
    guard value.range(of: pattern, options: .regularExpression) != nil else {
        throw failure("Contact birthday is invalid", code: 10)
    }
    let parts = value.split(separator: "-").compactMap { Int($0) }
    let month = yearless ? parts[0] : parts[1]
    let day = yearless ? parts[1] : parts[2]
    guard (1...12).contains(month), (1...31).contains(day) else {
        throw failure("Contact birthday is invalid", code: 10)
    }
    var result = DateComponents()
    if !yearless { result.year = parts[0] }
    result.month = month
    result.day = day
    return result
}

// Reuse the contact's own CNLabeledValue objects for unchanged label+value
// pairs instead of rebuilding every collection. Replacing a value Contacts
// already has forces contactsd to fault the old row out and delete it — and
// one dangling stored row then fails the WHOLE save with Cocoa 134092
// ("Unhandled error occurred during faulting"), persistently, even when the
// new values are identical. Verified live 2026-09-03: an update sending a
// card's exact current values failed on every attempt until unchanged rows
// were left untouched. (The JXA editor learned the same lesson earlier:
// unchanged collections retain their source fields.)
// Contacts.app's scripting layer reports an UNLABELED value under a default
// kind name — an email stored with label "" comes back as "Email", an
// unlabeled phone as "Phone" (observed live 2026-09-03). Drafts built from
// that view must not write those names back as literal custom labels, and
// must still MATCH the unlabeled source rows, so kind-default names
// normalize to nil on both sides of the comparison.
private func normalizedLabel(_ label: String?, defaults: [String]) -> String? {
    guard let label = label, !label.isEmpty, !defaults.contains(label) else { return nil }
    return label
}

private func reuseLabeled<T: NSCopying & NSSecureCoding>(
    _ existing: [CNLabeledValue<T>], desired: [LabeledValue], kindDefaults: [String],
    matches: (T, String) -> Bool, build: (String) -> T
) -> [CNLabeledValue<T>] {
    var pool = existing
    return desired.map { item in
        let label = normalizedLabel(item.label, defaults: kindDefaults)
        if let index = pool.firstIndex(where: {
            normalizedLabel($0.label, defaults: kindDefaults) == label && matches($0.value, item.value)
        }) {
            return pool.remove(at: index)
        }
        return CNLabeledValue(label: label, value: build(item.value))
    }
}

private func sameAddress(_ value: CNPostalAddress, _ desired: PostalAddress) -> Bool {
    value.street == desired.street && value.city == desired.city
        && value.state == desired.state && value.postalCode == desired.postalCode
        && value.country == desired.country && value.isoCountryCode == desired.countryCode
}

private func apply(_ card: Card, to contact: CNMutableContact) throws {
    if contact.givenName != card.firstName { contact.givenName = card.firstName }
    if contact.middleName != card.middleName { contact.middleName = card.middleName }
    if contact.familyName != card.lastName { contact.familyName = card.lastName }
    if contact.nickname != card.nickname { contact.nickname = card.nickname }
    if contact.organizationName != card.organization { contact.organizationName = card.organization }
    if contact.departmentName != card.department { contact.departmentName = card.department }
    if contact.jobTitle != card.jobTitle { contact.jobTitle = card.jobTitle }
    // A synced birthday carries calendar/timeZone/era the draft's bare
    // year-month-day components lack; leave an equal birthday untouched
    // rather than rewriting it in a different encoding.
    let birthday = try dateComponents(card.birthday)
    let sameBirthday = (birthday == nil) == (contact.birthday == nil)
        && birthday?.year == contact.birthday?.year
        && birthday?.month == contact.birthday?.month
        && birthday?.day == contact.birthday?.day
    if !sameBirthday { contact.birthday = birthday }
    let phones = reuseLabeled(contact.phoneNumbers, desired: card.phones,
                              kindDefaults: ["Phone"],
                              matches: { $0.stringValue == $1 },
                              build: { CNPhoneNumber(stringValue: $0) })
    if phones != contact.phoneNumbers { contact.phoneNumbers = phones }
    let emails = reuseLabeled(contact.emailAddresses, desired: card.emails,
                              kindDefaults: ["Email"],
                              matches: { ($0 as String) == $1 },
                              build: { $0 as NSString })
    if emails != contact.emailAddresses { contact.emailAddresses = emails }
    let urls = reuseLabeled(contact.urlAddresses, desired: card.urls,
                            kindDefaults: ["Url", "URL", "Website"],
                            matches: { ($0 as String) == $1 },
                            build: { $0 as NSString })
    if urls != contact.urlAddresses { contact.urlAddresses = urls }
    var addressPool = contact.postalAddresses
    let addresses = card.addresses.map { desired -> CNLabeledValue<CNPostalAddress> in
        let label = normalizedLabel(desired.label, defaults: ["Address"])
        if let index = addressPool.firstIndex(where: {
            normalizedLabel($0.label, defaults: ["Address"]) == label && sameAddress($0.value, desired)
        }) {
            return addressPool.remove(at: index)
        }
        let address = CNMutablePostalAddress()
        address.street = desired.street
        address.city = desired.city
        address.state = desired.state
        address.postalCode = desired.postalCode
        address.country = desired.country
        address.isoCountryCode = desired.countryCode
        return CNLabeledValue(label: label, value: address.copy() as! CNPostalAddress)
    }
    if addresses != contact.postalAddresses { contact.postalAddresses = addresses }
}

private func safeMessage(_ error: Error, stage: String) -> String {
    let nsError = error as NSError
    let raw: String
    if nsError.domain == NSCocoaErrorDomain && nsError.code == 134092 {
        raw = stage == "delete sources"
            ? "Contacts saved the merged contact but could not delete an old source card; reload the cards and try again"
            : "Contacts could not commit this save after several attempts; the card may have a damaged stored value — open it once in Contacts on the Mac, then retry"
    } else {
        raw = nsError.localizedDescription
    }
    // The stage and code make a report diagnosable without exposing content.
    let suffix = stage.isEmpty ? "" : " (stage: \(stage), code \(nsError.code))"
    let cleaned = raw.unicodeScalars.map { scalar -> Character in
        if CharacterSet.controlCharacters.contains(scalar) { return " " }
        return Character(String(scalar))
    }
    let body = String(cleaned).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    return String(body.prefix(180 - min(suffix.count, 60))) + suffix
}

var mutationStage = ""

private func isTransientSaveError(_ error: Error) -> Bool {
    let nsError = error as NSError
    return nsError.domain == NSCocoaErrorDomain && nsError.code == 134092
}

/// Contacts throws Cocoa 134092 when a save lands while contactsd is
/// rebuilding its unified graph or mid-account refresh — and Blip's own
/// preflight launches Contacts.app moments earlier, which kicks off CardDAV
/// refreshes of every account. Each retry therefore waits briefly and runs
/// the whole stage again against a FRESH store session, refetching every
/// object by its pinned identifier (the same medicine the cross-account
/// delete path always needed). Anything else still fails immediately.
private func withFreshStoreRetry(_ stage: String, attempts: Int = 3,
                                 _ body: (CNContactStore) throws -> Void) throws {
    for attempt in 1...attempts {
        mutationStage = stage
        do {
            try body(CNContactStore())
            return
        } catch {
            guard isTransientSaveError(error), attempt < attempts else { throw error }
            usleep(attempt == 1 ? 700_000 : 1_500_000)
        }
    }
}

private func mutableCard(_ card: Card, uid: String, in session: CNContactStore) throws -> CNMutableContact {
    let target = try exactContact(uid, in: session, keys: mutationKeys)
    guard let mutable = target.mutableCopy() as? CNMutableContact else {
        throw failure("Contacts returned a read-only target card", code: 17)
    }
    try apply(card, to: mutable)
    return mutable
}
do {
    let request = try JSONDecoder().decode(Request.self, from: boundedInput())
    guard ["available", "delete", "update", "consolidate", "names", "vcard", "counts"].contains(request.operation) else {
        throw failure("Contacts mutation operation is invalid", code: 11)
    }
    guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else {
        throw failure("Contacts access is not authorized on the Mac", code: 12)
    }
    let store = CNContactStore()

    if request.operation == "names" {
        guard let handles = request.handles else {
            throw failure("Contacts name request is missing", code: 22)
        }
        emit(Response(ok: true, availableCount: nil, deletedCount: nil,
                      updated: nil, error: nil,
                      names: try resolvedNames(handles, in: store)))
        exit(0)
    }

    if request.operation == "vcard" {
        guard let targetUid = request.targetUid, validId(targetUid), let card = request.card else {
            throw failure("Contacts vCard request is incomplete", code: 23)
        }
        try validateCard(card)
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactVCardSerialization.descriptorForRequiredKeys()
        ]
        let target = try exactContact(targetUid, in: store, keys: keys)
        guard let mutable = target.mutableCopy() as? CNMutableContact else {
            throw failure("Contacts returned a read-only vCard", code: 24)
        }
        try apply(card, to: mutable)
        let data = try CNContactVCardSerialization.data(with: [mutable])
        guard !data.isEmpty, data.count <= maxVCardBytes else {
            throw failure("The contact vCard is too large to copy", code: 25)
        }
        let display = [card.firstName, card.middleName, card.lastName]
            .filter { !$0.isEmpty }.joined(separator: " ")
        let name = !display.isEmpty ? display
            : (!card.organization.isEmpty ? card.organization : card.nickname)
        emit(VCardResponse(ok: true, name: name, vcard: data.base64EncodedString()),
             maximum: maxVCardResponseBytes)
        exit(0)
    }

    if request.operation == "update" {
        guard let targetUid = request.targetUid, validId(targetUid), let card = request.card else {
            throw failure("Contacts update request is incomplete", code: 26)
        }
        try validateCard(card)
        _ = try exactContact(targetUid, in: store, keys: [CNContactIdentifierKey as CNKeyDescriptor])
        try withFreshStoreRetry("update contact") { session in
            let save = CNSaveRequest()
            save.update(try mutableCard(card, uid: targetUid, in: session))
            try session.execute(save)
        }
        _ = try exactContact(targetUid, in: store,
                             keys: [CNContactIdentifierKey as CNKeyDescriptor])
        emit(Response(ok: true, availableCount: nil, deletedCount: nil,
                      updated: true, error: nil, names: nil))
        exit(0)
    }

    if request.operation == "counts" {
        guard let identifiers = request.personUids else {
            throw failure("Contacts mutation card list is missing", code: 13)
        }
        try validateIds(identifiers, maximum: 8)
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactUrlAddressesKey as CNKeyDescriptor,
            CNContactPostalAddressesKey as CNKeyDescriptor
        ]
        let contacts = try exactContacts(identifiers, in: store, keys: keys)
        guard contacts.count == identifiers.count else {
            throw failure("A selected Contacts source card no longer exists", code: 9)
        }
        emit(Response(ok: true, availableCount: nil, deletedCount: nil,
                      updated: nil, error: nil, names: nil,
                      counts: contacts.map { CardCounts(
                          uid: $0.identifier,
                          phones: $0.phoneNumbers.count,
                          emails: $0.emailAddresses.count,
                          urls: $0.urlAddresses.count,
                          addresses: $0.postalAddresses.count) }),
             maximum: 8192)
        exit(0)
    }

    if request.operation == "available" || request.operation == "delete" {
        guard let identifiers = request.personUids else {
            throw failure("Contacts mutation card list is missing", code: 13)
        }
        try validateIds(identifiers)
        let contacts = try exactContacts(
            identifiers, in: store, keys: [CNContactIdentifierKey as CNKeyDescriptor]
        )
        guard contacts.count == identifiers.count else {
            throw failure("A selected Contacts source card no longer exists", code: 9)
        }
        if request.operation == "available" {
            emit(Response(ok: true, availableCount: contacts.count, deletedCount: nil,
                          updated: nil, error: nil, names: nil))
            exit(0)
        }
        let save = CNSaveRequest()
        for contact in contacts {
            guard let mutable = contact.mutableCopy() as? CNMutableContact else {
                throw failure("Contacts returned a read-only card", code: 14)
            }
            save.delete(mutable)
        }
        mutationStage = "delete sources"
        try store.execute(save)
        try requireMissing(identifiers, in: store)
        emit(Response(ok: true, availableCount: nil, deletedCount: contacts.count,
                      updated: nil, error: nil, names: nil))
        exit(0)
    }

    guard let targetUid = request.targetUid, validId(targetUid),
          let sourceUids = request.sourceUids, let card = request.card else {
        throw failure("Contacts consolidation request is incomplete", code: 15)
    }
    try validateIds(sourceUids)
    guard !sourceUids.contains(targetUid) else {
        throw failure("Contacts consolidation target is also a source", code: 16)
    }
    try validateCard(card)
    let target = try exactContact(targetUid, in: store,
                                  keys: [CNContactIdentifierKey as CNKeyDescriptor])
    let sources = try sourceUids.map {
        try exactContact($0, in: store, keys: [CNContactIdentifierKey as CNKeyDescriptor])
    }
    let targetContainer = try containerIdentifier(for: target, in: store)
    let sourceContainers = try sources.map { try containerIdentifier(for: $0, in: store) }
    if sourceContainers.allSatisfy({ $0 == targetContainer }) {
        // One atomic request: survivor update and source deletes together. A
        // retry refetches everything in its fresh session and deletes only the
        // sources still present — a "failed" save can turn out to have
        // committed; requireMissing below stays the authoritative check.
        try withFreshStoreRetry("save same-account merge") { session in
            let save = CNSaveRequest()
            save.update(try mutableCard(card, uid: targetUid, in: session))
            let present = try exactContacts(
                sourceUids, in: session, keys: [CNContactIdentifierKey as CNKeyDescriptor])
            for source in present {
                guard let mutable = source.mutableCopy() as? CNMutableContact else {
                    throw failure("Contacts returned a read-only source card", code: 18)
                }
                save.delete(mutable)
            }
            try session.execute(save)
        }
    } else {
        // Contacts can reject a single CNSaveRequest that spans account-backed
        // persistent stores. Save the complete survivor first so no source data
        // is lost, then delete sources in one request per backing container.
        try withFreshStoreRetry("update survivor") { session in
            let update = CNSaveRequest()
            update.update(try mutableCard(card, uid: targetUid, in: session))
            try session.execute(update)
        }

        // Saving the survivor can cause Contacts to rebuild its unified-contact
        // graph. Objects fetched before that save may then retain stale backing-
        // store relationships and fail with Cocoa 134092 when deleted, so every
        // attempt refetches the source cards by their pinned identifiers in its
        // own fresh session. The fetch is lenient — an earlier partial attempt
        // may already have removed some sources; requireMissing below stays the
        // authoritative check that every one is gone.
        try withFreshStoreRetry("delete sources") { session in
            let present = try exactContacts(
                sourceUids, in: session, keys: [CNContactIdentifierKey as CNKeyDescriptor])
            var grouped: [String: [CNContact]] = [:]
            for source in present {
                let container = try containerIdentifier(for: source, in: session)
                grouped[container, default: []].append(source)
            }
            for contacts in grouped.values {
                let deletion = CNSaveRequest()
                for source in contacts {
                    guard let mutable = source.mutableCopy() as? CNMutableContact else {
                        throw failure("Contacts returned a read-only source card", code: 18)
                    }
                    deletion.delete(mutable)
                }
                try session.execute(deletion)
            }
        }
    }
    _ = try exactContact(targetUid, in: store,
                         keys: [CNContactIdentifierKey as CNKeyDescriptor])
    try requireMissing(sourceUids, in: store)
    emit(Response(ok: true, availableCount: nil, deletedCount: sources.count,
                  updated: true, error: nil, names: nil))
} catch {
    emit(Response(ok: false, availableCount: nil, deletedCount: nil,
                  updated: nil, error: safeMessage(error, stage: mutationStage), names: nil,
                  stage: mutationStage.isEmpty ? nil : mutationStage))
    exit(1)
}
