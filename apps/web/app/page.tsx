import Preloader from '@/components/Preloader';
import Navbar from '@/components/Navbar';
import Hero from '@/components/Hero';
import ScrollObserver from '@/components/ScrollObserver';
import ProblemSolution from '@/components/ProblemSolution';
import Architecture from '@/components/Architecture';
import Footer from '@/components/Footer';

export default function Home() {
  return (
    <>
      <ScrollObserver />
      <Preloader />
      <Navbar />
      <Hero />
      <ProblemSolution />
      <Architecture />
      <Footer />
    </>
  );
}
