import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui

ColumnLayout {
  id: root
  property var resolver: null
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property real fontScale: 1.0
  property real density: 1.0
  property real cornerScale: 1.0
  property bool discardUnsavedConfirm: false
  readonly property string animatedDots: "…"
  readonly property bool unsavedContactsError: resolver && /unsaved|pending changes/i.test(resolver.error)
  property string selectedToken: ""
  readonly property bool macReviewExpanded: true
  readonly property var selectedCandidate: candidateForToken(selectedToken)
  signal closeRequested()
  function fontSize(value) { return Math.max(1, Math.round(value * fontScale)) }
  function space(value) { return Math.max(1, Math.round(Style.spaceReal(value) * density)) }
  function corner(value) { return Math.max(0, Math.round(value * cornerScale)) }
  function handleNoun() { return resolver && resolver.activeHandle.indexOf("@") >= 0 ? "email" : "number" }
  function handleKey(value) { return resolver ? resolver.handleKey(value) : "" }
  function candidateForToken(token) {
    return resolver ? resolver.candidates.find(c => c.token === token) || null : null
  }
  function selectCandidate(candidate) {
    if (!candidate || !resolver || resolver.loading) return
    resolver.cancelRepair()
    resolver.cancelComparison()
    selectedToken = candidate.token
    resolver.compareCards(resolver.activeHandle, candidate.token)
  }
  Connections {
    target: root.resolver
    function onActiveHandleChanged() { root.selectedToken = "" }
    function onCandidatesChanged() {
      if (!root.candidateForToken(root.selectedToken)) root.selectedToken = ""
    }
  }
  Rectangle {
    Layout.fillWidth: true
    implicitHeight: guide.implicitHeight + root.space(20)
    color: "transparent"
    ColumnLayout {
      id: guide
      anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
      spacing: root.space(12)
      Rectangle {
        Layout.fillWidth: true
        visible: root.macReviewExpanded
        implicitHeight: 1
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
      }

      ColumnLayout {
        Layout.fillWidth: true
        visible: root.macReviewExpanded && (!root.resolver || root.resolver.comparison === null)
        spacing: root.space(8)
        SectionHeading { label: "MANAGE MAC CONTACTS" }
        SmallButton {
          visible: contactWorkspace.editorCard === null
            && (!root.resolver || root.resolver.mutationPreview === null)
            && (!root.resolver || root.resolver.repairPreview === null)
            && (!root.resolver || root.resolver.comparison === null)
          label: "Refresh source cards"
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.resolver.findCandidates(root.resolver.activeHandle)
        }

      }

      Text {
        Layout.fillWidth: true
        visible: root.macReviewExpanded && (!root.resolver || root.resolver.comparison === null)
        text: root.resolver && root.resolver.candidates.length > 1
          ? root.resolver.candidates.length + " different people are named for this " + root.handleNoun() + " in Contacts. Pick who this conversation belongs to — from there you can merge the cards or remove the " + root.handleNoun() + " from the wrong one."
          : root.selectedCandidate && root.selectedCandidate.recordCount > 1
            ? root.selectedCandidate.recordCount + " source cards found. Compare, edit, consolidate, delete, or link them from Blip."
            : root.selectedCandidate ? "One source card found. You can review, edit, or delete it from Blip."
              : "Choose a person to review their source cards."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      ColumnLayout {
        Layout.fillWidth: true
        visible: root.macReviewExpanded
        spacing: root.space(12)

      Text {
        Layout.fillWidth: true
        visible: root.resolver && root.resolver.candidates.length > 0 && root.selectedCandidate === null
        text: "Choose a person to review their cards."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
        font.bold: false
      }

      Repeater {
        model: root.resolver ? root.resolver.candidates : []
        delegate: Rectangle {
          id: sourceCandidate
          required property var modelData
          readonly property bool intended: root.selectedToken === modelData.token
          property bool cardsExpanded: !intended && modelData.recordCount <= 3
          visible: !(intended && root.resolver && root.resolver.comparison
            && root.resolver.comparison.ownerToken === modelData.token)
          Layout.fillWidth: true
          implicitHeight: sourceGroup.implicitHeight + root.space(16)
          radius: root.corner(root.space(9))
          color: intended
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.09)
            : root.selectedCandidate
              ? Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.07)
              : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.width: 1
          border.color: intended
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.35)
            : root.selectedCandidate
              ? Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.35)
              : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.2)

          ColumnLayout {
            id: sourceGroup
            anchors.fill: parent
            anchors.margins: root.space(8)
            spacing: root.space(6)
            ColumnLayout {
              Layout.fillWidth: true
              spacing: root.space(8)
              Text {
                Layout.fillWidth: true
                text: (sourceCandidate.intended ? "WORKING ON: "
                  : root.selectedCandidate
                    ? "OTHER PERSON USING THIS " + root.handleNoun().toUpperCase() + ": "
                    : "POSSIBLE PERSON: ")
                  + String(sourceCandidate.modelData.name || "")
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                color: sourceCandidate.intended || !root.selectedCandidate
                  ? root.foreground : root.urgent
                font.family: root.fontFamily
                font.pixelSize: root.fontSize(Style.font.caption)
                font.bold: true
              }
              SmallButton {
                // Explicit same-person declaration: opens the standard
                // compare/merge workspace spanning BOTH people's cards.
                visible: !sourceCandidate.intended && root.selectedCandidate !== null
                  && root.resolver && root.resolver.contactWrites
                label: "Merge with " + (root.selectedCandidate ? root.selectedCandidate.name : "") + "…"
                enabled: root.resolver && !root.resolver.loading
                onClicked: root.resolver.compareCards(
                  root.resolver.activeHandle, root.selectedToken, sourceCandidate.modelData.token)
              }
              SmallButton {
                label: !sourceCandidate.intended ? "Review cards…"
                  : root.resolver && root.resolver.comparison
                  && root.resolver.comparison.ownerToken === sourceCandidate.modelData.token
                  ? "Contact workspace open"
                  : sourceCandidate.modelData.recordCount === 1 ? "Manage contact…"
                    : "Manage " + sourceCandidate.modelData.recordCount + " cards…"
                enabled: root.resolver && !root.resolver.loading
                  && (!sourceCandidate.intended || !root.resolver.comparison
                    || root.resolver.comparison.ownerToken !== sourceCandidate.modelData.token)
                onClicked: {
                  if (sourceCandidate.intended) root.resolver.compareCards(
                    root.resolver.activeHandle, sourceCandidate.modelData.token)
                  else root.selectCandidate(sourceCandidate.modelData)
                }
              }
              SmallButton {
                label: sourceCandidate.cardsExpanded
                  ? "Hide cards"
                  : "Show " + sourceCandidate.modelData.recordCount
                    + (sourceCandidate.modelData.recordCount === 1 ? " card" : " cards")
                enabled: root.resolver && !root.resolver.loading
                onClicked: sourceCandidate.cardsExpanded = !sourceCandidate.cardsExpanded
              }
            }
            Text {
              Layout.fillWidth: true
              text: sourceCandidate.intended
                ? "You’re reviewing this person’s cards temporarily — nothing is saved as a Blip name, and every Mac Contacts change asks for its own confirmation."
                : root.selectedCandidate
                  ? "A different person? Remove just this " + root.handleNoun() + " from their card. The same person under another name (a married-name change, say)? Merge the cards — you can adjust the surviving name during the review."
                  : "Review, edit, merge cards, or remove this " + root.handleNoun() + " from the wrong card."
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: Qt.darker(root.foreground, 1.4)
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.caption)
            }
            Repeater {
              model: sourceCandidate.cardsExpanded ? sourceCandidate.modelData.cards : []
              delegate: ColumnLayout {
                id: sourceCard
                required property var modelData
                required property int index
                Layout.fillWidth: true
                spacing: root.space(8)
                Text {
                  Layout.fillWidth: true
                  text: "Card " + (sourceCard.index + 1) + " of " + sourceCandidate.modelData.recordCount
                    + " · " + sourceCard.modelData.sourceName
                    + (sourceCandidate.modelData.sourceCount > 1
                      ? " · source " + sourceCard.modelData.accountNumber
                        + " of " + sourceCandidate.modelData.sourceCount : "")
                    + (sourceCard.modelData.matchCount > 1
                      ? " · " + sourceCard.modelData.matchCount + " matching fields" : "")
                    + (sourceCard.modelData.hasPhoto ? " · has photo" : "")
                  textFormat: Text.PlainText
                  elide: Text.ElideRight
                  color: Qt.darker(root.foreground, 1.4)
                  font.family: root.fontFamily
                  font.pixelSize: root.fontSize(Style.font.caption)
                }
                SmallButton {
                  label: "Open card " + (sourceCard.index + 1) + " on Mac…"
                  enabled: root.resolver && !root.resolver.loading
                  onClicked: root.resolver.openOnMac(root.resolver.activeHandle, sourceCard.modelData.token)
                }
                SmallButton {
                  visible: !sourceCandidate.intended && root.selectedCandidate !== null
                    && root.resolver && root.resolver.contactWrites
                  danger: true
                  label: "Remove this " + root.handleNoun() + "…"
                  enabled: root.resolver && !root.resolver.loading
                  onClicked: root.resolver.inspectOnMac(
                    root.resolver.activeHandle, sourceCard.modelData.token, root.selectedToken)
                }
              }
            }
          }
        }
      }

      ContactCardCompare {
        id: contactWorkspace
        Layout.fillWidth: true
        visible: root.resolver && root.resolver.comparison !== null
          && root.resolver.comparison.ownerToken === root.selectedToken
        resolver: root.resolver
        comparison: root.resolver ? root.resolver.comparison : null
        foreground: root.foreground
        urgent: root.urgent
        accent: root.accent
        fontFamily: root.fontFamily
        fontScale: root.fontScale
        density: root.density
        cornerScale: root.cornerScale
      }

      Rectangle {
        Layout.fillWidth: true
        visible: root.resolver && root.resolver.repairPreview !== null
        implicitHeight: repairConfirmation.implicitHeight + root.space(20)
        radius: root.corner(root.space(9))
        color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.09)
        border.width: 2
        border.color: root.urgent

        ColumnLayout {
          id: repairConfirmation
          anchors.fill: parent
          anchors.margins: root.space(10)
          spacing: root.space(7)
          Text {
            Layout.fillWidth: true
            text: root.resolver && root.resolver.repairPreview
              ? "Remove " + root.resolver.repairPreview.handle + " from “"
                + root.resolver.repairPreview.name + "”?"
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.bodySmall)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: root.resolver && root.resolver.repairPreview
              ? "Verified card " + root.resolver.repairPreview.cardNumber + " of "
                + root.resolver.repairPreview.cardCount + " from "
                + root.resolver.repairPreview.sourceName + ". This will remove "
                + root.resolver.repairPreview.fieldCount + " matching "
                + root.resolver.repairPreview.kind
                + (root.resolver.repairPreview.fieldCount === 1 ? " field" : " fields")
                + " from synced Mac Contacts. An undo receipt will be saved on the Mac."
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
          Text {
            Layout.fillWidth: true
            visible: root.resolver && root.resolver.repairPreview
              && !root.resolver.repairPreview.writeEnabled
            text: "The Mac-side contact-writes gate is disabled. Re-run setup with explicit contact-write access."
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
            font.bold: true
          }
          ColumnLayout {
            Layout.fillWidth: true
            spacing: root.space(8)
            Item { Layout.fillWidth: true }
            SmallButton {
              label: "Cancel"
              enabled: root.resolver && !root.resolver.loading
              onClicked: root.resolver.cancelRepair()
            }
            SmallButton {
              danger: true
              primary: true
              label: "Remove from Mac Contacts"
              enabled: root.resolver && !root.resolver.loading
                && root.resolver.repairPreview && root.resolver.repairPreview.writeEnabled
              onClicked: root.resolver.removeOnMac()
            }
          }
        }
      }

      Rectangle {
        Layout.fillWidth: true
        // The undo offer belongs to the contact it changed — one merge's
        // receipt must not follow the user into another person's workspace.
        // The token stays in memory, so returning to that contact within the
        // session re-offers it (the private Mac receipt outlives both).
        visible: root.resolver && /^undo:[0-9a-f]{32}$/.test(root.resolver.undoToken)
          && root.handleKey(root.resolver.undoHandle)
             === root.handleKey(root.resolver.activeHandle)
        implicitHeight: undoContents.implicitHeight + root.space(18)
        radius: root.corner(root.space(9))
        color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.12)
        border.width: 1
        border.color: root.accent
        ColumnLayout {
          id: undoContents
          anchors.fill: parent
          anchors.margins: root.space(9)
          spacing: root.space(8)
          Text {
            Layout.fillWidth: true
            text: root.resolver
              ? (root.resolver.undoAction === "edit" ? "Edited one source card for “"
                : root.resolver.undoAction === "delete" ? "Deleted one source card for “"
                : root.resolver.undoAction === "consolidate"
                  ? "Consolidated " + root.resolver.undoCardCount + " source cards for “"
                  : "Removed " + root.resolver.undoHandle + " from “")
                + root.resolver.undoName
                + "”. Undo is available here now; its private Mac receipt expires in seven days."
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
          SmallButton {
            primary: true
            label: "Undo Mac change"
            enabled: root.resolver && !root.resolver.loading
            onClicked: root.resolver.undoOnMac()
          }
        }
      }

      Text {
        Layout.fillWidth: true
        visible: root.resolver && !root.resolver.contactWrites
        text: "Contact editing is disabled. Set contact_writes=on locally and enable the separate owner-only gate on the Mac to use it. Viewing and opening cards remain read-only."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      Text {
        Layout.fillWidth: true
        visible: contactWorkspace.editorCard === null && root.resolver
          && root.resolver.candidates.length > 0 && root.selectedCandidate !== null
        text: "Viewing or opening a card makes no change. Editing, deletion, consolidation, and handle removal all require a separate confirmation."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      }
    }
  }

  Text {
    Layout.fillWidth: true
    visible: root.resolver && (root.resolver.error !== "" || root.resolver.notice !== "")
    // While an operation runs ("Consolidating the verified source cards…"),
    // the notice's ellipsis animates as a three-dot progress indicator.
    text: root.resolver && root.resolver.error !== ""
      ? root.resolver.error
      : root.resolver && root.resolver.loading
        ? String(root.resolver.notice).replace(/…$/, "") + root.animatedDots
        : String(root.resolver ? root.resolver.notice : "")
    textFormat: Text.PlainText
    wrapMode: Text.WordWrap
    color: root.resolver && root.resolver.error !== "" ? root.urgent : Qt.darker(root.foreground, 1.4)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
  }

  Rectangle {
    Layout.fillWidth: true
    implicitHeight: unsavedRecovery.implicitHeight + root.space(20)
    visible: root.unsavedContactsError
    radius: root.corner(root.space(8))
    color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.07)
    border.width: 1
    border.color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.55)

    ColumnLayout {
      id: unsavedRecovery
      anchors.fill: parent
      anchors.margins: root.space(10)
      spacing: root.space(8)

      Text {
        Layout.fillWidth: true
        text: root.discardUnsavedConfirm
          ? "Discard every pending change currently open in Contacts on the Mac?"
          : "Contacts is holding an unfinished in-memory edit."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
        font.bold: true
      }
      Text {
        Layout.fillWidth: true
        text: root.discardUnsavedConfirm
          ? "This closes Contacts without saving. Continue only if the pending edit is the failed Blip attempt; any separate edit you made directly on the Mac would also be discarded."
          : "Finish or discard a real edit in Contacts on the Mac. If this was left by Blip’s failed save, Blip can close Contacts without saving it after one more confirmation."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.3)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }
      ColumnLayout {
        Layout.fillWidth: true
        Item { Layout.fillWidth: true }
        SmallButton {
          visible: root.discardUnsavedConfirm
          label: "Cancel"
          onClicked: root.discardUnsavedConfirm = false
        }
        SmallButton {
          danger: root.discardUnsavedConfirm
          primary: !root.discardUnsavedConfirm
          label: root.discardUnsavedConfirm
            ? "Discard and close Contacts" : "Resolve pending edit…"
          enabled: root.resolver && !root.resolver.loading
          onClicked: {
            if (!root.discardUnsavedConfirm) {
              root.discardUnsavedConfirm = true
              return
            }
            root.discardUnsavedConfirm = false
            root.resolver.discardUnsavedContacts()
          }
        }
      }
    }
  }

  component SectionHeading: Text {
    property string label: ""
    Layout.fillWidth: true
    text: label
    textFormat: Text.PlainText
    color: Qt.darker(root.foreground, 1.2)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
    font.bold: true
  }

  component SmallButton: ContactButton {
    property string label: ""
    property bool danger: false
    property bool primary: false
    text: label
    foreground: danger ? root.urgent : root.foreground
    accent: root.accent
    fontFamily: root.fontFamily
    fontSize: root.fontSize(Style.font.caption)
    Layout.maximumWidth: Math.max(1, root.width - root.space(56))
  }
}
