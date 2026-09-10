import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui

// Full, local editor for the bounded Contacts fields exposed by the bridge.
// Saving is always a two-step preview/apply operation in ContactOperations.
ColumnLayout {
  id: root

  property var resolver: null
  property var card: null
  property var comparison: null
  property var initialCard: null
  property string mode: "edit"
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property real fontScale: 1.0
  property real density: 1.0
  property real cornerScale: 1.0
  readonly property bool isMerge: mode === "consolidate"
  readonly property bool previewOpen: resolver && resolver.mutationPreview !== null

  signal closeRequested()

  spacing: space(14)

  function fontSize(value) { return Math.max(1, Math.round(value * fontScale)) }
  function space(value) { return Math.max(1, Math.round(Style.spaceReal(value) * density)) }
  function corner(value) { return Math.max(0, Math.round(value * cornerScale)) }
  function text(value) { return String(value || "") }
  function cleanLabel(value) {
    var label = text(value)
    var apple = /^_\$!<(.+)>!\$_$/.exec(label)
    return apple ? apple[1] : label
  }
  function loadValueModel(model, values) {
    model.clear()
    var source = Array.isArray(values) ? values : []
    for (var i = 0; i < source.length && i < 16; i++) {
      var item = source[i] || ({})
      model.append({
        label: cleanLabel(item.label),
        originalLabel: text(item.label),
        value: text(item.value)
      })
    }
  }
  function loadAddressModel(model, values) {
    model.clear()
    var source = Array.isArray(values) ? values : []
    for (var i = 0; i < source.length && i < 16; i++) {
      var item = source[i] || ({})
      model.append({
        label: cleanLabel(item.label),
        originalLabel: text(item.label),
        street: text(item.street),
        city: text(item.city),
        state: text(item.state),
        postalCode: text(item.postalCode),
        country: text(item.country),
        countryCode: text(item.countryCode)
      })
    }
  }
  function reload() {
    var source = initialCard || card
    if (!source) return
    firstName.text = text(source.firstName)
    middleName.text = text(source.middleName)
    lastName.text = text(source.lastName)
    nickname.text = text(source.nickname)
    organization.text = text(source.organization)
    department.text = text(source.department)
    jobTitle.text = text(source.jobTitle)
    birthday.text = text(source.birthday)
    notes.text = text(source.note)
    loadValueModel(phones, source.phones)
    loadValueModel(emails, source.emails)
    loadValueModel(urls, source.urls)
    loadAddressModel(addresses, source.addresses)
  }
  function modelValues(model, keys) {
    var result = []
    for (var i = 0; i < model.count; i++) {
      var source = model.get(i)
      var item = ({})
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j]
        var value = text(source[key]).trim()
        if (key === "label") {
          var original = text(source.originalLabel).trim()
          item[key] = original !== "" && value === cleanLabel(original) ? original : value
        } else item[key] = value
      }
      var meaningful = false
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] !== "label" && item[keys[k]] !== "") meaningful = true
      }
      if (meaningful) result.push(item)
    }
    return result
  }
  function draft() {
    return {
      firstName: firstName.text.trim(), middleName: middleName.text.trim(),
      lastName: lastName.text.trim(), nickname: nickname.text.trim(),
      organization: organization.text.trim(), department: department.text.trim(),
      jobTitle: jobTitle.text.trim(), birthday: birthday.text.trim(), note: notes.text.trim(),
      phones: modelValues(phones, ["label", "value"]),
      emails: modelValues(emails, ["label", "value"]),
      urls: modelValues(urls, ["label", "value"]),
      addresses: modelValues(addresses,
        ["label", "street", "city", "state", "postalCode", "country", "countryCode"])
    }
  }
  function review() {
    if (!resolver || !card) return
    if (isMerge) resolver.prepareConsolidation(card, draft())
    else resolver.prepareCardEdit(card, draft())
  }
  function removedCardsLabel() {
    if (!resolver || !resolver.mutationPreview) return ""
    var cards = comparison && Array.isArray(comparison.cards) ? comparison.cards : []
    var result = []
    for (var i = 0; i < cards.length; i++) {
      var candidate = cards[i]
      if (!candidate || candidate.cardNumber === resolver.mutationPreview.cardNumber) continue
      result.push(candidate.sourceName + " · card " + candidate.cardNumber)
    }
    return result.length > 0 ? result.join("; ")
      : resolver.mutationPreview.sourceCardCount + " other source card(s)"
  }
  function addressSummary(value) {
    if (!value) return ""
    var parts = [value.street, value.city, value.state, value.postalCode, value.country]
    var result = []
    for (var i = 0; i < parts.length; i++) {
      var part = text(parts[i]).trim()
      if (part !== "") result.push(part)
    }
    return result.join(", ")
  }
  function closeEditor() {
    if (resolver && resolver.loading) return
    if (resolver) resolver.cancelMutation()
    closeRequested()
  }

  onCardChanged: Qt.callLater(reload)
  onInitialCardChanged: Qt.callLater(reload)
  Component.onCompleted: reload()

  ListModel { id: phones }
  ListModel { id: emails }
  ListModel { id: urls }
  ListModel { id: addresses }

  RowLayout {
    Layout.fillWidth: true
    spacing: root.space(10)
    ColumnLayout {
      Layout.fillWidth: true
      spacing: root.space(2)
      Text {
        Layout.fillWidth: true
        text: root.previewOpen
          ? root.isMerge ? "Review merged contact" : "Review contact changes"
          : root.isMerge ? "Build one merged contact" : "Edit source card " + (root.card ? root.card.cardNumber : "")
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.body)
        font.bold: true
      }
      Text {
        Layout.fillWidth: true
        text: root.previewOpen
          ? "Nothing has been written to Mac Contacts yet. Review the result and source-card outcome below."
          : root.isMerge
          ? (root.card ? root.card.sourceName : "Contacts source") + " · card "
            + (root.card ? root.card.cardNumber : "") + " will remain; the other source cards will be deleted after confirmation."
          : (root.card ? root.card.sourceName : "Contacts source") + " · card "
            + (root.card ? root.card.cardNumber : "")
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }
    }
    ActionButton { label: "Close editor"; enabled: !root.resolver || !root.resolver.loading; onClicked: root.closeEditor() }
  }

  NoticeBox {
    visible: !root.previewOpen
    tone: root.isMerge ? "warning" : "info"
    message: root.isMerge
      ? "Review every field below. Blip started with the target card’s choices, filled its blanks, and combined unique phone, email, website, and address values. The target card’s photo is retained; photos on deleted source cards are not copied."
      : "Changes stay in this form until you click Review changes. Blip then rechecks the exact Mac card and shows a separate confirmation before saving. The existing photo is retained."
  }

  SectionTitle { visible: !root.previewOpen; label: "NAME & WORK" }
  GridLayout {
    visible: !root.previewOpen
    Layout.fillWidth: true
    columns: width >= root.space(720) ? 2 : 1
    columnSpacing: root.space(12)
    rowSpacing: root.space(9)
    Field { id: firstName; title: "First name"; maximum: 160 }
    Field { id: middleName; title: "Middle name"; maximum: 160 }
    Field { id: lastName; title: "Last name"; maximum: 160 }
    Field { id: nickname; title: "Nickname"; maximum: 160 }
    Field { id: organization; title: "Organization" }
    Field { id: department; title: "Department" }
    Field { id: jobTitle; title: "Job title" }
    Field { id: birthday; title: "Birthday"; hint: "YYYY-MM-DD or --MM-DD"; maximum: 10 }
  }

  ValueList { visible: !root.previewOpen; title: "PHONE NUMBERS"; model: phones; emptyLabel: "Add phone" }
  ValueList { visible: !root.previewOpen; title: "EMAIL ADDRESSES"; model: emails; emptyLabel: "Add email" }
  ValueList { visible: !root.previewOpen; title: "WEBSITES"; model: urls; emptyLabel: "Add website" }

  RowLayout {
    visible: !root.previewOpen
    Layout.fillWidth: true
    SectionTitle { Layout.fillWidth: true; label: "POSTAL ADDRESSES" }
  }
  Text {
    Layout.fillWidth: true
    visible: !root.previewOpen && addresses.count === 0
    text: "No postal addresses"
    textFormat: Text.PlainText
    color: Qt.darker(root.foreground, 1.4)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
  }
  Repeater {
    model: root.previewOpen ? null : addresses
    delegate: Rectangle {
      id: addressRow
      required property int index
      required property string label
      required property string street
      required property string city
      required property string state
      required property string postalCode
      required property string country
      required property string countryCode
      Layout.fillWidth: true
      implicitHeight: addressFields.implicitHeight + root.space(20)
      radius: root.corner(root.space(8))
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
      border.width: 1
      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.16)
      ColumnLayout {
        id: addressFields
        anchors.fill: parent
        anchors.margins: root.space(10)
        spacing: root.space(7)
        RowLayout {
          Layout.fillWidth: true
          Text { Layout.fillWidth: true; text: "ADDRESS " + (addressRow.index + 1); textFormat: Text.PlainText;
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.caption); font.bold: true }
          ActionButton { danger: true; label: "Remove"; enabled: !root.previewOpen; onClicked: addresses.remove(addressRow.index) }
        }
        GridLayout {
          Layout.fillWidth: true
          columns: width >= root.space(700) ? 2 : 1
          columnSpacing: root.space(10); rowSpacing: root.space(7)
          AddressField { title: "Label"; role: "label"; value: addressRow.label; row: addressRow.index; maximum: 80 }
          AddressField { title: "Street"; role: "street"; value: addressRow.street; row: addressRow.index; maximum: 320 }
          AddressField { title: "City"; role: "city"; value: addressRow.city; row: addressRow.index; maximum: 320 }
          AddressField { title: "State / region"; role: "state"; value: addressRow.state; row: addressRow.index; maximum: 320 }
          AddressField { title: "Postal code"; role: "postalCode"; value: addressRow.postalCode; row: addressRow.index; maximum: 80 }
          AddressField { title: "Country"; role: "country"; value: addressRow.country; row: addressRow.index; maximum: 160 }
          AddressField { title: "Country code"; role: "countryCode"; value: addressRow.countryCode; row: addressRow.index; maximum: 8 }
        }
      }
    }
  }
  RowLayout {
    visible: !root.previewOpen
    Layout.fillWidth: true
    Layout.topMargin: root.space(2)
    Layout.bottomMargin: root.space(4)
    Item { Layout.fillWidth: true }
    ActionButton {
      label: "Add address"
      enabled: addresses.count < 16 && !root.previewOpen
      onClicked: addresses.append({ label: "", originalLabel: "", street: "", city: "", state: "",
        postalCode: "", country: "", countryCode: "" })
    }
  }

  SectionTitle { visible: !root.previewOpen; label: "NOTES" }
  TextField {
    id: notes
    Layout.fillWidth: true
    placeholderText: "Notes"
    foreground: root.foreground; accent: root.accent
    font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.bodySmall)
    maximumLength: 1000
    enabled: !root.previewOpen
    visible: !root.previewOpen
  }

  MutationReview {
    Layout.fillWidth: true
    visible: root.resolver && root.resolver.mutationPreview !== null
    preview: root.resolver ? root.resolver.mutationPreview : null
  }

  RowLayout {
    Layout.fillWidth: true
    visible: !root.resolver || root.resolver.mutationPreview === null
    spacing: root.space(8)
    ActionButton {
      visible: !root.isMerge
      danger: true
      label: "Delete this source card…"
      enabled: root.resolver && !root.resolver.loading && root.resolver.contactWrites
      onClicked: root.resolver.prepareCardDelete(root.card)
    }
    Item { Layout.fillWidth: true }
    ActionButton { label: "Discard draft"; onClicked: root.closeEditor() }
    ActionButton {
      primary: true
      label: root.isMerge ? "Review merged contact…" : "Review changes…"
      enabled: root.resolver && !root.resolver.loading && root.resolver.contactWrites
      onClicked: root.review()
    }
  }

  component SectionTitle: Text {
    property string label: ""
    Layout.fillWidth: true
    text: label
    textFormat: Text.PlainText
    color: root.accent
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
    font.bold: true
  }

  component Field: ColumnLayout {
    id: fieldBox
    property alias text: input.text
    property string title: ""
    property string hint: ""
    property int maximum: 320
    Layout.fillWidth: true
    spacing: root.space(4)
    Text { text: parent.title; textFormat: Text.PlainText; color: Qt.darker(root.foreground, 1.25);
      font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.caption) }
    TextField {
      id: input
      Layout.fillWidth: true
      placeholderText: fieldBox.hint
      foreground: root.foreground; accent: root.accent
      font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.bodySmall)
      maximumLength: fieldBox.maximum
      enabled: !root.previewOpen
    }
  }

  component ValueList: ColumnLayout {
    id: valueList
    property string title: ""
    property string emptyLabel: "Add value"
    required property ListModel model
    Layout.fillWidth: true
    spacing: root.space(6)
    SectionTitle { label: valueList.title }
    Text {
      Layout.fillWidth: true
      visible: parent.model.count === 0
      text: "None"
      textFormat: Text.PlainText
      color: Qt.darker(root.foreground, 1.4)
      font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.caption)
    }
    Repeater {
      model: parent.model
      delegate: RowLayout {
        id: valueRow
        required property int index
        required property string label
        required property string value
        Layout.fillWidth: true
        spacing: root.space(7)
        TextField {
          Layout.preferredWidth: root.space(150)
          text: valueRow.label
          placeholderText: "Label"
          foreground: root.foreground; accent: root.accent
          font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.bodySmall)
          maximumLength: 80
          enabled: !root.previewOpen
          onTextChanged: valueList.model.setProperty(valueRow.index, "label", text)
        }
        TextField {
          Layout.fillWidth: true
          text: valueRow.value
          placeholderText: "Value"
          foreground: root.foreground; accent: root.accent
          font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.bodySmall)
          maximumLength: 320
          enabled: !root.previewOpen
          onTextChanged: valueList.model.setProperty(valueRow.index, "value", text)
        }
        ActionButton { danger: true; label: "Remove"; enabled: !root.previewOpen; onClicked: valueList.model.remove(valueRow.index) }
      }
    }
    RowLayout {
      Layout.fillWidth: true
      Layout.topMargin: root.space(2)
      Layout.bottomMargin: root.space(4)
      Item { Layout.fillWidth: true }
      ActionButton {
        label: valueList.emptyLabel
        enabled: valueList.model.count < 16 && !root.previewOpen
        onClicked: valueList.model.append({ label: "", originalLabel: "", value: "" })
      }
    }
  }

  component AddressField: ColumnLayout {
    property string title: ""
    property string role: ""
    property string value: ""
    property int row: 0
    property int maximum: 320
    Layout.fillWidth: true
    spacing: root.space(3)
    Text { text: parent.title; textFormat: Text.PlainText; color: Qt.darker(root.foreground, 1.3);
      font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.caption) }
    TextField {
      Layout.fillWidth: true; text: parent.value
      foreground: root.foreground; accent: root.accent
      font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.bodySmall)
      maximumLength: parent.maximum
      enabled: !root.previewOpen
      onTextChanged: addresses.setProperty(parent.row, parent.role, text)
    }
  }

  component NoticeBox: Rectangle {
    property string tone: "info"
    property string message: ""
    Layout.fillWidth: true
    implicitHeight: noticeText.implicitHeight + root.space(20)
    radius: root.corner(root.space(8))
    color: tone === "warning" ? Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.08)
      : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.07)
    border.width: 1
    border.color: tone === "warning" ? root.urgent : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.38)
    Text { id: noticeText; anchors.fill: parent; anchors.margins: root.space(10); text: parent.message;
      textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: root.foreground;
      font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.caption) }
  }

  component MutationReview: Rectangle {
    id: reviewBox
    required property var preview
    Layout.fillWidth: true
    implicitHeight: reviewContent.implicitHeight + root.space(28)
    radius: root.corner(root.space(12))
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
    border.width: 1
    border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.42)

    ColumnLayout {
      id: reviewContent
      anchors.fill: parent
      anchors.margins: root.space(14)
      spacing: root.space(14)

      ColumnLayout {
        Layout.fillWidth: true
        spacing: root.space(4)
        Text {
          Layout.fillWidth: true
          text: reviewBox.preview && reviewBox.preview.action === "consolidate"
            ? "REVIEW CONSOLIDATION" : reviewBox.preview && reviewBox.preview.action === "delete"
              ? "REVIEW DELETION" : "REVIEW CONTACT CHANGES"
          textFormat: Text.PlainText
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
          font.bold: true
        }
        Text {
          Layout.fillWidth: true
          text: "This is a read-only preview. Nothing below has been saved to Contacts."
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.bodySmall)
          font.bold: true
        }
      }

      Rectangle {
        Layout.fillWidth: true
        implicitHeight: sourceOutcome.implicitHeight + root.space(20)
        radius: root.corner(root.space(8))
        color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.07)
        border.width: 1
        border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.3)
        ColumnLayout {
          id: sourceOutcome
          anchors.fill: parent
          anchors.margins: root.space(10)
          spacing: root.space(6)
          ReviewOutcomeRow {
            label: reviewBox.preview && reviewBox.preview.action === "delete" ? "DELETE" : "KEEP AND UPDATE"
            value: reviewBox.preview
              ? reviewBox.preview.sourceName + " · card " + reviewBox.preview.cardNumber : ""
            danger: reviewBox.preview && reviewBox.preview.action === "delete"
          }
          ReviewOutcomeRow {
            visible: reviewBox.preview && reviewBox.preview.action === "consolidate"
            label: "DELETE AFTER MERGE"
            value: root.removedCardsLabel()
            danger: true
          }
          Text {
            Layout.fillWidth: true
            text: reviewBox.preview
              ? "Different from the surviving card: " + reviewBox.preview.changedFields.join(", ") + "."
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: Qt.darker(root.foreground, 1.3)
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
        }
      }

      SectionTitle {
        label: reviewBox.preview && reviewBox.preview.action === "delete"
          ? "CONTACT CARD TO DELETE" : reviewBox.preview && reviewBox.preview.action === "consolidate"
            ? "MERGED CONTACT TO KEEP" : "CONTACT AFTER SAVING"
      }
      GridLayout {
        Layout.fillWidth: true
        columns: width >= root.space(720) ? 2 : 1
        columnSpacing: root.space(10)
        rowSpacing: root.space(8)
        ReviewField { label: "First name"; value: firstName.text }
        ReviewField { label: "Middle name"; value: middleName.text }
        ReviewField { label: "Last name"; value: lastName.text }
        ReviewField { label: "Nickname"; value: nickname.text }
        ReviewField { label: "Organization"; value: organization.text }
        ReviewField { label: "Department"; value: department.text }
        ReviewField { label: "Job title"; value: jobTitle.text }
        ReviewField { label: "Birthday"; value: birthday.text }
      }
      ReviewValueList { title: "PHONE NUMBERS"; sourceModel: phones }
      ReviewValueList { title: "EMAIL ADDRESSES"; sourceModel: emails }
      ReviewValueList { title: "WEBSITES"; sourceModel: urls }

      ColumnLayout {
        Layout.fillWidth: true
        visible: addresses.count > 0
        spacing: root.space(6)
        SectionTitle { label: "POSTAL ADDRESSES" }
        Repeater {
          model: addresses
          delegate: ReviewOutcomeRow {
            required property string street
            required property string city
            required property string state
            required property string postalCode
            required property string country
            value: root.addressSummary({ street: street, city: city, state: state,
              postalCode: postalCode, country: country })
          }
        }
      }

      ColumnLayout {
        Layout.fillWidth: true
        visible: notes.text.trim() !== ""
        spacing: root.space(6)
        SectionTitle { label: "NOTES" }
        Text {
          Layout.fillWidth: true
          text: notes.text
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.bodySmall)
        }
      }

      Rectangle {
        Layout.fillWidth: true
        implicitHeight: finalConfirmation.implicitHeight + root.space(22)
        radius: root.corner(root.space(9))
        color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.08)
        border.width: 1
        border.color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.65)
        ColumnLayout {
          id: finalConfirmation
          anchors.fill: parent
          anchors.margins: root.space(11)
          spacing: root.space(8)
          Text {
            Layout.fillWidth: true
            text: "FINAL CONFIRMATION"
            textFormat: Text.PlainText
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: reviewBox.preview ? reviewBox.preview.action === "edit"
              ? "Save this reviewed contact to " + reviewBox.preview.sourceName + "?"
              : reviewBox.preview.action === "delete"
                ? "Delete this reviewed source card from " + reviewBox.preview.sourceName + "?"
                : "Save the reviewed merged contact to " + reviewBox.preview.sourceName
                  + " and delete " + reviewBox.preview.sourceCardCount + " other source card(s)?"
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.bodySmall)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: reviewBox.preview ? reviewBox.preview.action === "delete"
              ? "Undo can recreate the text fields in the default writable account, but cannot restore the original account placement, links, or photo."
              : reviewBox.preview.action === "consolidate"
                ? "Undo can recreate removed text fields as new cards, but their original account placement, links, and photos cannot be guaranteed."
                : "An owner-only undo receipt will be saved on the Mac."
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: Qt.darker(root.foreground, 1.25)
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
          RowLayout {
            Layout.fillWidth: true
            spacing: root.space(8)
            Item { Layout.fillWidth: true }
            ActionButton { label: "Back to edit"; onClicked: root.resolver.cancelMutation() }
            ActionButton {
              danger: reviewBox.preview && reviewBox.preview.action !== "edit"
              primary: true
              label: reviewBox.preview && reviewBox.preview.action === "edit"
                ? "Save to Mac Contacts" : reviewBox.preview && reviewBox.preview.action === "delete"
                  ? "Delete card from Contacts" : "Merge and delete source cards"
              enabled: root.resolver && !root.resolver.loading && reviewBox.preview
                && reviewBox.preview.writeEnabled
              onClicked: root.resolver.applyMutation()
            }
          }
        }
      }
    }
  }

  component ReviewField: Rectangle {
    property string label: ""
    property string value: ""
    Layout.fillWidth: true
    visible: value.trim() !== ""
    implicitHeight: reviewFieldContent.implicitHeight + root.space(16)
    radius: root.corner(root.space(7))
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.045)
    ColumnLayout {
      id: reviewFieldContent
      anchors.fill: parent
      anchors.margins: root.space(8)
      spacing: root.space(2)
      Text { text: parent.parent.label; textFormat: Text.PlainText; color: Qt.darker(root.foreground, 1.35);
        font.family: root.fontFamily; font.pixelSize: root.fontSize(Style.font.caption) }
      Text { Layout.fillWidth: true; text: parent.parent.value; textFormat: Text.PlainText;
        wrapMode: Text.WordWrap; color: root.foreground; font.family: root.fontFamily;
        font.pixelSize: root.fontSize(Style.font.bodySmall); font.bold: true }
    }
  }

  component ReviewValueList: ColumnLayout {
    id: reviewList
    property string title: ""
    required property ListModel sourceModel
    Layout.fillWidth: true
    visible: sourceModel.count > 0
    spacing: root.space(6)
    SectionTitle { label: reviewList.title }
    Repeater {
      model: reviewList.sourceModel
      delegate: ReviewOutcomeRow {}
    }
  }

  component ReviewOutcomeRow: RowLayout {
    required property string label
    required property string value
    property bool danger: false
    Layout.fillWidth: true
    spacing: root.space(10)
    Text {
      Layout.preferredWidth: root.space(170)
      text: parent.label === "" ? "UNLABELED" : parent.label.toUpperCase()
      textFormat: Text.PlainText
      color: parent.danger ? root.urgent : Qt.darker(root.foreground, 1.3)
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.caption)
      font.bold: true
    }
    Text {
      Layout.fillWidth: true
      text: parent.value
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.bodySmall)
    }
  }

  component ActionButton: Rectangle {
    id: button
    property string label: ""
    property bool danger: false
    property bool primary: false
    signal clicked()
    implicitWidth: buttonText.implicitWidth + root.space(16)
    implicitHeight: buttonText.implicitHeight + root.space(10)
    radius: root.corner(root.space(7)); opacity: enabled ? 1.0 : 0.45
    color: hover.hovered ? Qt.rgba((danger ? root.urgent : root.accent).r,
      (danger ? root.urgent : root.accent).g, (danger ? root.urgent : root.accent).b, 0.18)
      : primary ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.2)
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.055)
    border.width: 1; border.color: danger ? root.urgent : primary ? root.accent
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
    Text { id: buttonText; anchors.centerIn: parent; text: button.label; textFormat: Text.PlainText;
      color: button.danger ? root.urgent : root.foreground; font.family: root.fontFamily;
      font.pixelSize: root.fontSize(Style.font.caption); font.bold: button.primary }
    HoverHandler { id: hover; enabled: button.enabled; cursorShape: Qt.PointingHandCursor }
    TapHandler { enabled: button.enabled; onTapped: button.clicked() }
  }
}
