// Experimental public-API glyph transport. NOT a send command.
// --dry-run never accesses the clipboard. --clipboard is opt-in and restores
// its RAM-only snapshot on request, EOF, signal, or a 45-second deadline.
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <poll.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted = 0;
static void interruptProbe(int sig) { interrupted = sig; }
static void emit(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static NSData *readPng(NSString *path) {
    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return nil;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > 10 * 1024 * 1024) { close(fd); return nil; }
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)st.st_size];
    size_t done = 0;
    while (done < data.length) {
        ssize_t n = read(fd, (char *)data.mutableBytes + done, data.length - done);
        if (n <= 0) { close(fd); return nil; }
        done += (size_t)n;
    }
    close(fd);
    return data;
}
static CGImageRef makeImage(NSString *path) {
    CGImageRef original = NULL;
    if (path.length) {
        NSData *data = readPng(path);
        if (!data) return NULL;
        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
        if (!source) return NULL;
        NSString *type = (__bridge NSString *)CGImageSourceGetType(source);
        NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
        NSUInteger width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] unsignedIntegerValue];
        NSUInteger height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] unsignedIntegerValue];
        if (![type isEqualToString:UTTypePNG.identifier] || width < 1 || height < 1 || width > 2048 || height > 2048) { CFRelease(source); return NULL; }
        original = CGImageSourceCreateImageAtIndex(source, 0, NULL); CFRelease(source);
        if (!original) return NULL;
    }
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef c = CGBitmapContextCreate(NULL, 160, 160, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!c) { if (original) CGImageRelease(original); return NULL; }
    if (original) {
        double width = CGImageGetWidth(original), height = CGImageGetHeight(original);
        double ratio = MIN(160 / width, 160 / height);
        CGContextSetInterpolationQuality(c, kCGInterpolationHigh);
        CGContextDrawImage(c, CGRectMake((160-width*ratio)/2, (160-height*ratio)/2, width*ratio, height*ratio), original);
        CGImageRelease(original);
    } else {
        CGContextSetRGBFillColor(c, 1.0, 0.67, 0.08, 1.0);
        for (int i = 0; i < 10; i++) {
            double angle = M_PI/2 + i*M_PI/5, radius = i%2 ? 30 : 69;
            double x = 80 + cos(angle)*radius, y = 80 + sin(angle)*radius;
            if (!i) CGContextMoveToPoint(c,x,y); else CGContextAddLineToPoint(c,x,y);
        }
        CGContextClosePath(c); CGContextFillPath(c);
    }
    CGImageRef image = CGBitmapContextCreateImage(c); CGContextRelease(c); return image;
}
static NSData *makeRichGlyph(NSDictionary *request, NSMutableDictionary *status) {
    NSString *path = request[@"inputPath"];
    NSString *label = request[@"description"] ?: @"Synthetic golden star";
    if ((path && ![path isKindOfClass:NSString.class]) || ![label isKindOfClass:NSString.class] || label.length < 1 || label.length > 160) return nil;
    CGImageRef image = makeImage(path);
    if (!image) return nil;
    NSString *identity = NSUUID.UUID.UUIDString;
    CGMutableImageMetadataRef metadata = CGImageMetadataCreateMutable();
    BOOL named = CGImageMetadataSetValueWithPath(metadata,NULL,CFSTR("tiff:DocumentName"),(__bridge CFStringRef)identity);
    BOOL described = CGImageMetadataSetValueWithPath(metadata,NULL,CFSTR("dc:description"),(__bridge CFStringRef)label);
    NSMutableData *data = [NSMutableData data];
    CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data,
        (__bridge CFStringRef)NSAdaptiveImageGlyph.contentType.identifier, 1, NULL);
    if (!dest || !named || !described) { if(dest) CFRelease(dest); CFRelease(metadata); CGImageRelease(image); return nil; }
    CGImageDestinationAddImageAndMetadata(dest,image,metadata,NULL);
    BOOL encoded = CGImageDestinationFinalize(dest);
    CFRelease(dest); CFRelease(metadata); CGImageRelease(image);
    if (!encoded) return nil;
    NSAdaptiveImageGlyph *glyph = [[NSAdaptiveImageGlyph alloc] initWithImageContent:data];
    if (!glyph || ![glyph.contentIdentifier isEqual:identity] || ![glyph.contentDescription isEqual:label]) return nil;
    NSAttributedString *string = [NSAttributedString attributedStringWithAdaptiveImageGlyph:glyph attributes:@{}];
    NSError *error = nil;
    NSData *rtfd = [string dataFromRange:NSMakeRange(0,string.length)
        documentAttributes:@{NSDocumentTypeDocumentAttribute:NSRTFDTextDocumentType} error:&error];
    NSAttributedString *decoded = rtfd ? [[NSAttributedString alloc] initWithData:rtfd
        options:@{NSDocumentTypeDocumentOption:NSRTFDTextDocumentType} documentAttributes:nil error:&error] : nil;
    NSAdaptiveImageGlyph *again = decoded.length ? [decoded attribute:NSAdaptiveImageGlyphAttributeName atIndex:0 effectiveRange:NULL] : nil;
    if (!again || ![again.contentIdentifier isEqual:identity]) return nil;
    status[@"contentIdentifier"] = identity;
    status[@"contentType"] = NSAdaptiveImageGlyph.contentType.identifier;
    status[@"pasteboardType"] = NSPasteboardTypeRTFD;
    status[@"heicBytes"] = @(data.length); status[@"rtfdBytes"] = @(rtfd.length);
    status[@"roundTrip"] = @YES;
    return rtfd;
}
int main(int argc, const char **argv) { @autoreleasepool {
    BOOL clipboardMode = argc == 2 && strcmp(argv[1],"--clipboard") == 0;
    if (!clipboardMode && !(argc == 2 && strcmp(argv[1],"--dry-run") == 0)) { emit(@{@"ok":@NO,@"error":@"use --dry-run or explicit --clipboard"}); return 64; }
    char line[16384];
    if (!fgets(line,sizeof(line),stdin) || !strchr(line,'\n')) { emit(@{@"ok":@NO,@"error":@"one bounded JSON line required"}); return 64; }
    NSData *requestData = [NSData dataWithBytes:line length:strlen(line)];
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:requestData options:0 error:NULL];
    if (![request isKindOfClass:NSDictionary.class]) { emit(@{@"ok":@NO,@"error":@"invalid request"}); return 64; }
    NSMutableDictionary *status = [NSMutableDictionary dictionaryWithObject:@YES forKey:@"ok"];
    NSData *rtfd = nil;
    @try { rtfd = makeRichGlyph(request,status); } @catch (NSException *e) { }
    if (!rtfd) { emit(@{@"ok":@NO,@"error":@"could not create and round-trip public adaptive glyph"}); return 65; }
    if (!clipboardMode) { status[@"clipboardTouched"] = @NO; emit(status); return 0; }
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    NSInteger originalCount = board.changeCount;
    NSArray *items = board.pasteboardItems ?: @[];
    NSMutableArray *snapshot = [NSMutableArray array];
    NSUInteger total = 0, typeCount = 0;
    if (items.count > 16) { emit(@{@"ok":@NO,@"error":@"clipboard snapshot exceeds item bound"}); return 65; }
    for (NSPasteboardItem *item in items) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            total += data.length; typeCount++;
            if (!data || total > 10*1024*1024 || typeCount > 128 || ![copy setData:data forType:type]) {
                emit(@{@"ok":@NO,@"error":@"clipboard cannot be preserved within bounds"}); return 65;
            }
        }
        [snapshot addObject:copy];
    }
    if (board.changeCount != originalCount) { emit(@{@"ok":@NO,@"error":@"clipboard changed before publish"}); return 75; }
    struct sigaction action = {0}; action.sa_handler = interruptProbe;
    sigaction(SIGINT,&action,NULL); sigaction(SIGTERM,&action,NULL); sigaction(SIGHUP,&action,NULL);
    signal(SIGPIPE,SIG_IGN);
    // No snapshot bytes leave RAM. Original drafts are untouched by this
    // helper; the controller must refuse to paste into a nonempty composer.
    [board clearContents];
    BOOL wrote = [board setData:rtfd forType:NSPasteboardTypeRTFD];
    NSInteger publishedCount = board.changeCount;
    status[@"published"] = @(wrote); status[@"clipboardTouched"] = @YES;
    status[@"restoreDeadlineSeconds"] = @45; status[@"changeCount"] = @(publishedCount); emit(status);
    CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 45;
    char command[64]; size_t commandLength = 0;
    while (wrote && !interrupted && CFAbsoluteTimeGetCurrent() < deadline) {
        struct pollfd input = { .fd=STDIN_FILENO, .events=POLLIN };
        int ready = poll(&input,1,250);
        if (ready > 0 && (input.revents & (POLLIN|POLLHUP|POLLERR))) {
            char byte; ssize_t n = read(STDIN_FILENO, &byte, 1);
            if (n <= 0) break;
            if (byte == '\n' || commandLength == sizeof(command)-1) {
                command[commandLength] = 0;
                if (strcmp(command,"status") != 0) break;
                emit(@{@"active":@(board.changeCount == publishedCount),
                       @"secondsRemaining":@(MAX(0,deadline-CFAbsoluteTimeGetCurrent()))});
                commandLength = 0;
            } else command[commandLength++] = byte;
        }
    }
    BOOL unchanged = board.changeCount == publishedCount, restored = NO;
    if (unchanged) {
        [board clearContents]; restored = snapshot.count == 0 || [board writeObjects:snapshot];
    }
    emit(@{@"restored":@(restored),@"newClipboardPreserved":@(!unchanged)});
    return restored || !unchanged ? 0 : 74;
} }
