import com.dukascopy.api.*;
import com.dukascopy.api.system.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.io.BufferedWriter;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.*;
import java.util.concurrent.*;

/** Reads BID history only. Contains no order submission or account modification. */
public final class ReplayHistory implements IStrategy {
    private static final long DAY = 86400000L;
    private static final String[] ASSETS = {"XAUUSD", "EURUSD", "GBPUSD", "GER40"};
    private static final String[] SYMBOLS = {"XAU/USD", "EUR/USD", "GBP/USD", "DEU.IDX/EUR"};
    private final long from, to;
    private final Path out;
    private final CountDownLatch done = new CountDownLatch(1);
    private volatile boolean success;
    private ReplayHistory(long from, long to, Path out) { this.from=from; this.to=to; this.out=out; }

    public static void main(String[] args) {
        int code=1;
        IClient client=null;
        try {
            if (args.length != 3) throw new IllegalArgumentException("Expected FROM TO OUTPUT");
            long from=LocalDate.parse(args[0]).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli();
            long to=LocalDate.parse(args[1]).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli();
            if (from>=to || to-from>45*DAY || to>System.currentTimeMillis()/DAY*DAY)
                throw new IllegalArgumentException("Invalid completed-day range (maximum 45 days)");
            String user=System.getenv("DUKASCOPY_USERNAME"), pass=System.getenv("DUKASCOPY_PASSWORD");
            if(user==null || user.isEmpty() || pass==null || pass.isEmpty()) throw new IllegalArgumentException("Missing JForex secrets");
            ReplayHistory reader=new ReplayHistory(from,to,Paths.get(args[2]));
            Files.createDirectories(reader.out);
            client=ClientFactory.getDefaultInstance();
            client.setSystemListener(new ISystemListener() {
                public void onStart(long id) {}
                public void onStop(long id) { reader.done.countDown(); }
                public void onConnect() { System.out.println("JForex demo connected"); }
                public void onDisconnect() { System.out.println("JForex disconnected"); }
            });
            // Fixed demo destination; credentials are never command-line arguments or output.
            client.connect("https://platform.dukascopy.com/demo_3/jforex_3.jnlp",user,pass);
            long deadline=System.currentTimeMillis()+90000;
            while(!client.isConnected() && System.currentTimeMillis()<deadline) Thread.sleep(500);
            if(!client.isConnected()) throw new IllegalStateException("Demo connection timeout");
            Set<Instrument> instruments=new HashSet<>();
            for(String symbol:SYMBOLS) {
                Instrument instrument=Instrument.fromString(symbol);
                if(instrument==null) throw new IllegalStateException("Unknown instrument: "+symbol);
                instruments.add(instrument);
            }
            client.setSubscribedInstruments(instruments);
            deadline=System.currentTimeMillis()+90000;
            while(!client.getSubscribedInstruments().containsAll(instruments) && System.currentTimeMillis()<deadline) Thread.sleep(500);
            if(!client.getSubscribedInstruments().containsAll(instruments)) throw new IllegalStateException("Subscription timeout");
            client.startStrategy(reader);
            if(!reader.done.await(20,TimeUnit.MINUTES)) throw new IllegalStateException("History timeout");
            if(!reader.success) throw new IllegalStateException("History export failed");
            code=0;
        } catch(Exception e) {
            // Avoid SDK exception messages which can contain account identifiers.
            System.err.println("JForex reader failed: "+e.getClass().getSimpleName());
        } finally { if(client!=null) client.disconnect(); }
        System.exit(code);
    }
    public void onStart(IContext context) {
        try {
            Period[] periods={Period.ONE_HOUR,Period.FIVE_MINS};
            String[] names={"h1","m5"};
            for(int i=0;i<ASSETS.length;i++) for(int p=0;p<periods.length;p++) {
                Path file=out.resolve(ASSETS[i]+"_"+names[p]+".csv");
                int count=0;
                long previous=-1;
                try(BufferedWriter writer=Files.newBufferedWriter(file,StandardCharsets.UTF_8)) {
                    writer.write("timestamp,open,high,low,close,volume\n");
                    for(long day=from;day<to;day+=DAY) {
                        List<IBar> bars=context.getHistory().getBars(Instrument.fromString(SYMBOLS[i]), periods[p], OfferSide.BID, Filter.WEEKENDS, day, day+DAY-periods[p].getInterval());
                        for(IBar bar:bars) {
                            long t=bar.getTime();
                            if(t<day || t>=day+DAY || t<=previous) throw new IllegalStateException("Unexpected candle order");
                            previous=t;
                            if(bar.getVolume()<=0) continue;
                            writer.write(t+","+bar.getOpen()+","+bar.getHigh()+","+bar.getLow()+","+bar.getClose()+","+bar.getVolume()+"\n");
                            count++;
                        }
                    }
                }
                if(count==0) throw new IllegalStateException("Empty history");
                System.out.println(ASSETS[i]+" "+names[p]+": "+count+" BID candles");
            }
            success=true;
        } catch(Exception e) {
            System.err.println("Historical data read failed: "+e.getClass().getSimpleName());
        } finally { done.countDown(); context.stop(); }
    }
    public void onTick(Instrument i,ITick t) {}
    public void onBar(Instrument i,Period p,IBar a,IBar b) {}
    public void onMessage(IMessage m) {}
    public void onAccount(IAccount a) {}
    public void onStop() { done.countDown(); }
}
